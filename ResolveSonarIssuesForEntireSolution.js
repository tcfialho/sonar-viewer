const vscode = require('vscode');
const fs = require('fs').promises;
const path = require('path');
const { 
    getCurrentGitBranch, 
    getProjectIdFromConfig, 
    getAccessToken, 
    getStackSpotClientId, 
    getStackSpotClientSecret,
    fetchIssues,
    groupIssuesByFile,
    fetchSourceForFiles,
    getClientCredentialsToken,
    executeRemoteQuickCommand,
    getQuickCommandResult,
    extractCodeBlock
} = require('./utils');

async function findFileInWorkspace(relativePath) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        throw new Error('No workspace folder open');
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const normalizedRelativePath = relativePath.split(/[\/\\]+/).join(path.sep);

    async function searchDirectory(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const result = await searchDirectory(fullPath);
                if (result) return result;
            } else if (fullPath.endsWith(normalizedRelativePath)) {
                return fullPath;
            }
        }
        return null;
    }

    return await searchDirectory(workspaceRoot);
}

async function resolveSonarIssuesForEntireSolution(lastUsedBranch) {
    console.log('Iniciando resolução de issues do SonarCloud para toda a solução');

    const projectId = await getProjectIdFromConfig();
    if (!projectId) {
        vscode.window.showErrorMessage('ID do projeto SonarCloud não encontrado.');
        return lastUsedBranch;
    }

    let token = await getAccessToken();
    if (!token) {
        vscode.window.showErrorMessage('Token de acesso do SonarCloud não fornecido.');
        return lastUsedBranch;
    }

    const currentBranch = await getCurrentGitBranch();
    let branch = currentBranch || lastUsedBranch;

    if (!branch) {
        branch = await vscode.window.showInputBox({
            prompt: 'Digite o nome da branch para análise',
            placeHolder: 'Ex: main, master, develop, feature/nova-funcionalidade'
        });

        if (!branch) {
            console.log('Seleção de branch cancelada pelo usuário');
            return lastUsedBranch;
        }
    }

    lastUsedBranch = branch;

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Resolvendo issues do SonarCloud para toda a solução",
            cancellable: false
        }, async (progress) => {
            // Passo 1: Obter a lista de issues do Sonar
            progress.report({ message: "Obtendo issues do SonarCloud..." });
            const issues = await fetchIssues(projectId, branch, token);
            const issuesByFile = groupIssuesByFile(issues);

            // Passo 2: Comentar as issues em cada arquivo
            progress.report({ message: "Comentando issues nos arquivos..." });
            const filesWithSource = await fetchSourceForFiles(projectId, branch, token, Object.keys(issuesByFile));
            const commentedFiles = commentIssuesInFiles(issuesByFile, filesWithSource);

            // Passos 3-5: Resolver issues e atualizar arquivos
            const totalFiles = Object.keys(commentedFiles).length;
            let processedFiles = 0;

            const stackSpotClientId = await getStackSpotClientId();
            const stackSpotClientSecret = await getStackSpotClientSecret();
            const stackSpotToken = await getClientCredentialsToken(stackSpotClientId, stackSpotClientSecret);

            for (const [filePath, commentedContent] of Object.entries(commentedFiles)) {
                progress.report({ message: `Resolvendo issues para ${filePath} (${processedFiles + 1}/${totalFiles})` });

                // Passo 3: Submeter o código comentado para revisão
                const resolvedContent = await resolveIssuesForFile(stackSpotToken, commentedContent);

                // Passo 5: Atualizar o arquivo com as issues resolvidas
                await updateFileContent(filePath, resolvedContent);

                processedFiles++;
                progress.report({ increment: 100 / totalFiles });
            }
        });

        vscode.window.showInformationMessage('Resolução de issues do SonarCloud para toda a solução concluída.');
    } catch (error) {
        console.error('Erro ao resolver issues do SonarCloud:', error);
        vscode.window.showErrorMessage(`Erro ao resolver issues do SonarCloud: ${error.message}`);
    }

    return lastUsedBranch;
}

function commentIssuesInFiles(issuesByFile, filesWithSource) {
    const commentedFiles = {};

    for (const [filePath, fileIssues] of Object.entries(issuesByFile)) {
        const sourceLines = filesWithSource[filePath];
        if (!sourceLines) continue;

        const commentedLines = [...sourceLines];
        for (const issue of fileIssues) {
            if (issue.line && issue.line <= commentedLines.length) {
                const commentText = `// SonarCloud: ${issue.rule} - ${issue.message}`;
                commentedLines.splice(issue.line - 1, 0, commentText);
            }
        }

        commentedFiles[filePath] = commentedLines.join('\n');
    }

    return commentedFiles;
}

async function resolveIssuesForFile(token, commentedContent) {
    const executionId = await executeRemoteQuickCommand(token, commentedContent);
    let result = null;
    let attempts = 0;
    const maxAttempts = 30;

    while (!result && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        result = await getQuickCommandResult(token, executionId);
        attempts++;
    }

    if (result && result.progress.status === 'COMPLETED') {
        return extractCodeBlock(result.result);
    } else {
        throw new Error('Failed to resolve issues for file.');
    }
}

async function updateFileContent(filePath, newContent) {
    const [projectId, relativePath] = filePath.split(':');
    const cleanRelativePath = relativePath.startsWith(projectId) 
        ? relativePath.slice(projectId.length).replace(/^[\/\\]+/, '')
        : relativePath;

    try {
        const absolutePath = await findFileInWorkspace(cleanRelativePath);
        if (absolutePath) {
            await fs.writeFile(absolutePath, newContent, 'utf8');
            console.log(`Arquivo atualizado com sucesso: ${absolutePath}`);
        } else {
            throw new Error(`Arquivo não encontrado: ${cleanRelativePath}`);
        }
    } catch (error) {
        console.error(`Erro ao atualizar o arquivo ${cleanRelativePath}:`, error);
        throw error;
    }
}

module.exports = {
    resolveSonarIssuesForEntireSolution
};