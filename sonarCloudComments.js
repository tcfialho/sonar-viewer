const vscode = require('vscode');
const https = require('https');
const { execSync } = require('child_process');
const { getCurrentGitBranch, getProjectIdFromConfig, getAccessToken } = require('./utils');

async function addSonarCommentsToFile(lastUsedBranch) {
    console.log('Comando addSonarCommentsToFile iniciado');

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Nenhum arquivo aberto para adicionar comentários.');
        return lastUsedBranch;
    }

    const projectId = await getProjectIdFromConfig();
    console.log(`ProjectId obtido: ${projectId}`);

    if (!projectId) {
        console.error('ID do projeto SonarCloud não encontrado.');
        vscode.window.showErrorMessage('ID do projeto SonarCloud não encontrado.');
        return lastUsedBranch;
    }

    let token = await getAccessToken();
    if (!token) {
        console.error('Token de acesso não fornecido.');
        vscode.window.showErrorMessage('Token de acesso do SonarCloud não fornecido.');
        return lastUsedBranch;
    }

    const currentBranch = await getCurrentGitBranch();
    console.log(`Branch atual do Git: ${currentBranch}`);

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
    console.log(`Branch selecionada: ${branch}`);

    try {
        const fileUri = editor.document.uri;
        const filePath = fileUri.path;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        let relativePath = filePath;
        if (workspaceFolders) {
            const workspacePath = workspaceFolders[0].uri.fsPath;
            relativePath = filePath.replace(workspacePath, '');
        }

        const issues = await fetchIssuesForFile(projectId, branch, token, relativePath);
        await addCommentsToFile(editor, issues, projectId, branch, token);
    } catch (error) {
        console.error('Erro ao adicionar comentários do SonarCloud:', error);
        vscode.window.showErrorMessage('Erro ao adicionar comentários do SonarCloud.');
    }

    return lastUsedBranch;
}

async function fetchIssuesForFile(projectId, branch, token, filePath) {
    const projectPath = filePath.substring(filePath.indexOf(projectId));
    const componentKey = `${projectId}:${projectPath}`;

    return new Promise((resolve, reject) => {
        const issuesUrl = `https://sonarcloud.io/api/issues/search?componentKeys=${encodeURIComponent(componentKey)}&branch=${encodeURIComponent(branch)}&ps=500&additionalFields=_all`;
        const options = { headers: { 'Authorization': `Bearer ${token}` } };

        https.get(issuesUrl, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const issuesData = JSON.parse(data);

                    if (issuesData.issues && issuesData.issues.length > 0) {
                        resolve(issuesData.issues);
                    } else {
                        if (branch === 'main') {
                            // Tentar novamente com a branch 'master'
                            resolve(fetchIssuesForFile(projectId, 'master', token, filePath));
                        } else {
                            resolve([]); // Retorna um array vazio em vez de null
                        }
                        
                    }
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', reject);
    });
}

async function addCommentsToFile(editor, issues, projectId, branch, token) {
    const document = editor.document;
    const filePath = document.uri.fsPath;

    const lastAnalyzedCommit = await getLastAnalyzedCommit(projectId, branch, token);
    const currentCommit = getCurrentCommit(filePath);

    let warningMessage = '';

    if (document.isDirty) {
        warningMessage = 'Por favor, salve o arquivo antes de prosseguir. ';
    } else if (isFileModifiedSinceCommit(filePath, lastAnalyzedCommit)) {
        warningMessage = 'Há modificações locais não analisadas. ';
    } else if (lastAnalyzedCommit !== currentCommit) {
        warningMessage = 'O arquivo local pode estar desatualizado em relação à última análise do SonarCloud. ';
    }
      
    if (warningMessage) {
        warningMessage += 'Considere fazer commit, push e aguardar uma nova análise antes de adicionar os comentários.';
        
        const choice = await vscode.window.showWarningMessage(warningMessage, 'Continuar Mesmo Assim', 'Cancelar');
        if (choice === 'Cancelar') {
          return;
        }
    }

    const edit = new vscode.WorkspaceEdit();
    const documentText = document.getText();

    const sonarCloudCommentRegex = /^.*\/\/\s*SonarCloud:.*$/gm;
    const cleanedText = documentText.replace(sonarCloudCommentRegex, '');

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(documentText.length)
    );
    edit.replace(document.uri, fullRange, cleanedText);

    for (const issue of issues) {
        if (issue.line) {
            const line = document.lineAt(issue.line - 1);
            const position = new vscode.Position(issue.line - 1, line.firstNonWhitespaceCharacterIndex);
            const commentText = `// SonarCloud: ${issue.rule} - ${issue.message}`;
            edit.insert(document.uri, position, commentText + '\n' + ' '.repeat(line.firstNonWhitespaceCharacterIndex));
        }
    }

    await vscode.workspace.applyEdit(edit);

    if (warningMessage) {
        vscode.window.showInformationMessage('Comentários adicionados, mas ' + warningMessage.toLowerCase());
    } else {
        vscode.window.showInformationMessage('Comentários do SonarCloud adicionados ao arquivo.');
    }
}

async function getLastAnalyzedCommit(projectId, branch, token) {
    return new Promise((resolve, reject) => {
        const url = `https://sonarcloud.io/api/project_analyses/search?project=${projectId}&branch=${branch}`;
        const options = { headers: { 'Authorization': `Bearer ${token}` } };

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const analysesData = JSON.parse(data);
                    if (analysesData.analyses && analysesData.analyses.length > 0) {
                        const lastAnalysis = analysesData.analyses[0];
                        resolve(lastAnalysis.revision);
                    } else {
                        if (branch === 'main') {
                            // Se main não retornar, tentar novamente com a branch 'master'
                            resolve(getLastAnalyzedCommit(projectId, 'master', token));
                        } else {
                            resolve(null);
                        }
                    }
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', reject);
    });
}

function getCurrentCommit(filePath) {
    try {
        return execSync(`git rev-parse HEAD`, { cwd: vscode.workspace.rootPath }).toString().trim();
    } catch (error) {
        console.error('Erro ao obter o commit atual:', error);
        return null;
    }
}

function isFileModifiedSinceCommit(filePath, commitHash) {
    try {
        execSync(`git diff --quiet ${commitHash} -- "${filePath}"`, { cwd: vscode.workspace.rootPath });
        return false;
    } catch (error) {
        return true;
    }
}

module.exports = {
    addSonarCommentsToFile
};