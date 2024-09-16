const vscode = require('vscode');
const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const { getCurrentGitBranch, getProjectIdFromConfig, getAccessToken, getStackSpotClientId, getStackSpotClientSecret } = require('./utils');

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

            for (const [filePath, commentedContent] of Object.entries(commentedFiles)) {
                progress.report({ message: `Resolvendo issues para ${filePath} (${processedFiles + 1}/${totalFiles})` });

                // Passo 3: Submeter o código comentado para revisão
                const resolvedContent = await resolveIssuesForFile(commentedContent);

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

async function fetchIssues(projectId, branch, token) {
    const issuesUrl = `https://sonarcloud.io/api/issues/search?componentKeys=${projectId}&branch=${branch}&ps=500&additionalFields=_all&statuses=OPEN`;
    const options = { headers: { 'Authorization': `Bearer ${token}` } };

    return new Promise((resolve, reject) => {
        https.get(issuesUrl, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Erro ao buscar issues: ${res.statusCode} ${res.statusMessage}`));
                } else {
                    try {
                        const issuesData = JSON.parse(data);
                        resolve(issuesData.issues || []);
                    } catch (error) {
                        reject(new Error('Erro ao parsear dados das issues'));
                    }
                }
            });
        }).on('error', (err) => reject(new Error(`Erro de rede: ${err.message}`)));
    });
}

function groupIssuesByFile(issues) {
    return issues.reduce((acc, issue) => {
        const componentKey = issue.component;
        acc[componentKey] = acc[componentKey] || [];
        acc[componentKey].push(issue);
        return acc;
    }, {});
}

async function fetchSourceForFiles(projectId, branch, token, fileKeys) {
    const filesWithSource = {};
    const fetchPromises = fileKeys.map(async (fileKey) => {
        const sourceUrl = `https://sonarcloud.io/api/sources/raw?key=${fileKey}&branch=${branch}`;
        const options = { headers: { 'Authorization': `Bearer ${token}` } };

        try {
            const sourceCode = await new Promise((resolve, reject) => {
                https.get(sourceUrl, options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        if (res.statusCode !== 200) {
                            reject(new Error(`Erro ao buscar código-fonte para ${fileKey}: ${res.statusCode} ${res.statusMessage}`));
                        } else {
                            resolve(data);
                        }
                    });
                }).on('error', (err) => reject(new Error(`Erro de rede: ${err.message}`)));
            });
            filesWithSource[fileKey] = sourceCode.split('\n');
        } catch (error) {
            filesWithSource[fileKey] = ['Código-fonte não disponível'];
        }
    });

    await Promise.all(fetchPromises);
    return filesWithSource;
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

async function resolveIssuesForFile(commentedContent) {
    const stackSpotClientId = await getStackSpotClientId();
    const stackSpotClientSecret = await getStackSpotClientSecret();
    const token = await getClientCredentialsToken(stackSpotClientId, stackSpotClientSecret);

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

async function getClientCredentialsToken(clientId, clientSecret) {
    console.log('Obtaining token using client credentials');
    const postData = `client_id=${encodeURIComponent(clientId)}&grant_type=client_credentials&client_secret=${encodeURIComponent(clientSecret)}`;

    const options = {
        hostname: 'idm.stackspot.com',
        path: '/zup/oidc/oauth/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0'
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    const response = JSON.parse(data);
                    console.log('Access token obtained successfully');
                    resolve(response.access_token);
                } else {
                    console.error('Failed to obtain token:', res.statusCode, res.statusMessage);
                    reject(new Error(`Failed to obtain token: ${res.statusCode} ${res.statusMessage}`));
                }
            });
        });

        req.on('error', error => {
            console.error('Error in token request:', error);
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

async function executeRemoteQuickCommand(token, fileContent, conversationId = null) {
    const postData = JSON.stringify({
        input_data: fileContent
    });

    let path = '/v1/quick-commands/create-execution/fix-sonar-issues-remote';
    if (conversationId) {
        path += `?conversation_id=${conversationId}`;
    }

    const options = {
        hostname: 'genai-code-buddy-api.stackspot.com',
        path: path,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0',
            'Content-Length': postData.length
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    // Remove aspas extras e espaços em branco
                    const cleanedData = data.trim().replace(/^"|"$/g, '');
                    resolve(cleanedData);
                } else {
                    reject(new Error(`Failed to execute quick command: ${res.statusCode} ${res.statusMessage}`));
                }
            });
        });

        req.on('error', error => {
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

async function getQuickCommandResult(token, executionId) {
    const options = {
        hostname: 'genai-code-buddy-api.stackspot.com',
        path: `/v1/quick-commands/callback/${executionId}`,
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Mozilla/5.0'
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    const response = JSON.parse(data);
                    if (response.progress.status === 'COMPLETED') {
                        resolve(response);
                    } else {
                        resolve(null); // Not completed yet
                    }
                } else {
                    reject(new Error(`Failed to get quick command result: ${res.statusCode} ${res.statusMessage}`));
                }
            });
        });

        req.on('error', error => {
            reject(error);
        });

        req.end();
    });
}

function extractCodeBlock(result) {
    if (typeof result === 'string') {
      const codeBlockRegex = /```[\s\S]*?\n([\s\S]*?)```/;
      const match = result.match(codeBlockRegex);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    return result; // Return original result if no code block is found or if result is not a string
}

module.exports = {
    resolveSonarIssuesForEntireSolution
};