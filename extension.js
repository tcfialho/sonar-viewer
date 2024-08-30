const vscode = require('vscode');
const https = require('https');
const { execSync } = require('child_process');

let lastUsedBranch = 'master'; // Branch padrão

async function getCurrentGitBranch() {
    try {
        const gitExtension = vscode.extensions.getExtension('vscode.git').exports;
        const api = gitExtension.getAPI(1);
        
        const repository = api.repositories[0];
        if (repository) {
            const branch = await repository.repository.HEAD.name;
            return branch || 'master';
        }
    } catch (error) {
        console.error('Erro ao obter a branch Git atual:', error);
    }
    return 'master';
}

function activate(context) {
    console.log('Extensão SonarCloudViewer ativada');

    let currentPanel = undefined;

    let disposable = vscode.commands.registerCommand('sonar-viewer.showSonarCloudViewer', async () => {
        console.log('Comando showSonarCloudViewer iniciado');

        const projectId = await getProjectIdFromConfig();
        console.log(`ProjectId obtido: ${projectId}`);
    
        if (!projectId) {
            console.error('ID do projeto SonarCloud não encontrado.');
            vscode.window.showErrorMessage('ID do projeto SonarCloud não encontrado.');
            return;
        }

        let token = await getAccessToken();
        if (!token) {
            console.error('Token de acesso não fornecido.');
            vscode.window.showErrorMessage('Token de acesso do SonarCloud não fornecido.');
            return;
        }

        // Obter a branch atual do Git
        const currentBranch = await getCurrentGitBranch();
        console.log(`Branch atual do Git: ${currentBranch}`);

        const branch = await vscode.window.showInputBox({
            prompt: 'Digite o nome da branch para análise',
            placeHolder: 'Ex: master, develop, feature/nova-funcionalidade',
            value: currentBranch || lastUsedBranch
        });

        if (!branch) {
            console.log('Seleção de branch cancelada pelo usuário');
            return;
        }

        lastUsedBranch = branch;
        console.log(`Branch selecionada: ${branch}`);

        if (currentPanel) {
            console.log('Painel existente encontrado, revelando-o');
            currentPanel.reveal(vscode.ViewColumn.Two);
        } else {
            console.log('Criando novo painel WebView');
            currentPanel = vscode.window.createWebviewPanel(
                'sonarCloudViewer',
                'SonarCloud Viewer',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            currentPanel.onDidDispose(
                () => {
                    console.log('Painel WebView foi fechado');
                    currentPanel = undefined;
                },
                null,
                context.subscriptions
            );
        }

        console.log('Atualizando conteúdo do WebView');
        updateWebviewContent(currentPanel, projectId, branch, token);
    });

    let addCommentsDisposable = vscode.commands.registerCommand('sonar-viewer.addSonarCommentsToFile', async () => {
        console.log('Comando addSonarCommentsToFile iniciado');
    
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('Nenhum arquivo aberto para adicionar comentários.');
            return;
        }
    
        const projectId = await getProjectIdFromConfig();
        console.log(`ProjectId obtido: ${projectId}`);
    
        if (!projectId) {
            console.error('ID do projeto SonarCloud não encontrado.');
            vscode.window.showErrorMessage('ID do projeto SonarCloud não encontrado.');
            return;
        }
    
        let token = await getAccessToken();
        if (!token) {
            console.error('Token de acesso não fornecido.');
            vscode.window.showErrorMessage('Token de acesso do SonarCloud não fornecido.');
            return;
        }
    
        // Obter a branch atual do Git
        const currentBranch = await getCurrentGitBranch();
        console.log(`Branch atual do Git: ${currentBranch}`);
    
        const branch = await vscode.window.showInputBox({
            prompt: 'Digite o nome da branch para análise',
            placeHolder: 'Ex: master, develop, feature/nova-funcionalidade',
            value: currentBranch || lastUsedBranch
        });
    
        if (!branch) {
            console.log('Seleção de branch cancelada pelo usuário');
            return;
        }
    
        lastUsedBranch = branch;
        console.log(`Branch selecionada: ${branch}`);
    
        try {
            const fileUri = editor.document.uri;
            const filePath = fileUri.path;
    
            // Assegura que estamos usando o caminho correto para o arquivo no projeto
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
    });

    context.subscriptions.push(disposable, addCommentsDisposable);
}

async function getProjectIdFromConfig() {
    try {
        // Tenta obter o nome do repositório
        const repoName = execSync('git rev-parse --show-toplevel', { cwd: vscode.workspace.rootPath })
            .toString()
            .trim()
            .split('/')
            .pop();

        if (repoName) {
            console.log(`Nome do repositório obtido: ${repoName}`);
            return repoName;
        }
    } catch (error) {
        console.error('Erro ao obter o nome do repositório:', error);
    }

    // Se não conseguir obter o nome do repositório, pergunta ao usuário
    const projectId = await vscode.window.showInputBox({
        prompt: 'Digite o ID do projeto SonarCloud',
        placeHolder: 'Ex: meu-projeto-api'
    });

    if (projectId) {
        // Salva o projectId nas configurações para uso futuro
        const config = vscode.workspace.getConfiguration('sonarCloudViewer');
        await config.update('projectId', projectId, vscode.ConfigurationTarget.Workspace);
    }

    return projectId;
}

async function getAccessToken() {
    const config = vscode.workspace.getConfiguration('sonarCloudViewer');
    let token = config.get('accessToken');

    if (!token) {
        token = await vscode.window.showInputBox({
            prompt: 'Digite seu token de acesso do SonarCloud',
            password: true
        });

        if (token) {
            await config.update('accessToken', token, vscode.ConfigurationTarget.Global);
        }
    }

    return token;
}

async function updateWebviewContent(panel, projectId, branch, token) {
    console.log(`Iniciando updateWebviewContent para projectId: ${projectId}, branch: ${branch}`);
    panel.webview.html = getLoadingHtml();

    try {
        const issues = await fetchIssues(projectId, branch, token);
        const issuesByFile = groupIssuesByFile(issues);
        const filesWithSource = await fetchSourceForFiles(projectId, branch, token, Object.keys(issuesByFile));
        panel.webview.html = getWebviewContent(projectId, branch, issuesByFile, filesWithSource);
    } catch (error) {
        console.error('Erro ao buscar dados do SonarCloud:', error);
        panel.webview.html = getErrorHtml();
    }
}

function fetchIssues(projectId, branch, token) {
    return new Promise((resolve, reject) => {
        const issuesUrl = `https://sonarcloud.io/api/issues/search?componentKeys=${projectId}&branch=${branch}&ps=500&additionalFields=_all`;
        const options = { headers: { 'Authorization': `Bearer ${token}` } };

        https.get(issuesUrl, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const issuesData = JSON.parse(data);
                    resolve(issuesData.issues);
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', reject);
    });
}

function groupIssuesByFile(issues) {
    return issues.reduce((acc, issue) => {
        const componentKey = issue.component;
        if (!acc[componentKey]) {
            acc[componentKey] = [];
        }
        acc[componentKey].push(issue);
        return acc;
    }, {});
}

async function fetchSourceForFiles(projectId, branch, token, fileKeys) {
    const filesWithSource = {};
    for (const fileKey of fileKeys) {
        const sourceUrl = `https://sonarcloud.io/api/sources/raw?key=${fileKey}&branch=${branch}`;
        const options = { headers: { 'Authorization': `Bearer ${token}` } };

        try {
            const sourceCode = await new Promise((resolve, reject) => {
                https.get(sourceUrl, options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => resolve(data));
                }).on('error', reject);
            });
            filesWithSource[fileKey] = sourceCode.split('\n');
        } catch (error) {
            console.error(`Erro ao buscar código-fonte para ${fileKey}:`, error);
            filesWithSource[fileKey] = ['Código-fonte não disponível'];
        }
    }
    return filesWithSource;
}

function getLoadingHtml() {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>SonarCloud Viewer</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
            </style>
        </head>
        <body>
            <h1>Carregando dados do SonarCloud...</h1>
        </body>
        </html>
    `;
}

function getErrorHtml() {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>SonarCloud Viewer - Erro</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                .error { color: red; }
            </style>
        </head>
        <body>
            <h1 class="error">Erro ao carregar dados do SonarCloud</h1>
            <p>Por favor, verifique sua conexão e tente novamente.</p>
        </body>
        </html>
    `;
}

function getWebviewContent(projectId, branch, issuesByFile, filesWithSource) {
    const escapeHtml = (unsafe) => {
        return unsafe.replace(/[&<>"']/g, (match) => {
            const entityMap = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            };
            return entityMap[match];
        });
    };

    const filesHtml = Object.entries(issuesByFile).map(([fileKey, fileIssues]) => {
        const sourceLines = filesWithSource[fileKey] || [];

        const issuesHtml = fileIssues
            .filter(issue => issue.line !== undefined)
            .map(issue => {
                const issueLine = issue.line;
                const startLine = Math.max(1, issueLine - 2);
                const endLine = Math.min(sourceLines.length, issueLine + 2);

                const codeSnippet = sourceLines.slice(startLine - 1, endLine).map((line, index) => {
                    const lineNumber = startLine + index;
                    const isIssueLine = lineNumber === issueLine;
                    let lineHtml = '';

                    if (isIssueLine) {
                        // Adiciona o comentário na linha anterior à linha afetada com a indentação correta
                        const previousLineIndentation = line.match(/^\s*/)[0];
                        lineHtml += `<div class="issue-line">${escapeHtml(`${previousLineIndentation}// ${issue.rule} - ${issue.message}`)}</div>`;
                    }

                    // Adiciona o código da linha afetada com a mesma indentação
                    lineHtml += `<div class="${isIssueLine ? 'issue-line' : ''}">${escapeHtml(line)}</div>`;

                    return lineHtml;
                }).join('');

                return `
                    <div class="issue">
                        <p class="issue-header">
                            <strong>Código: ${issue.rule}</strong>
                            <span class="issue-meta">Tipo: ${issue.type}, Severidade: ${issue.severity}</span>
                        </p>
                        <pre><code>${codeSnippet}</code></pre>
                    </div>
                `;
            }).join('');

        return issuesHtml ? `
            <div class="file">
                <h2 class="file-path">${fileKey}</h2>
                ${issuesHtml}
            </div>
        ` : '';
    }).join('');

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>SonarCloud Viewer</title>
            <style>
                body {
                    font-family: var(--vscode-editor-font-family, Arial, sans-serif);
                    padding: 20px;
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .file {
                    margin-bottom: 30px;
                    border: 1px solid var(--vscode-panel-border);
                    padding: 15px;
                    background-color: var(--vscode-editor-background);
                }
                .issue {
                    margin-bottom: 15px;
                    border-left: 3px solid var(--vscode-textLink-foreground);
                    padding-left: 10px;
                }
                .issue-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 5px;
                }
                .issue-meta {
                    font-size: 0.9em;
                    color: var(--vscode-descriptionForeground);
                }
                pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 10px;
                    overflow-x: auto;
                    border-radius: 3px;
                }
                code {
                    font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
                    font-size: var(--vscode-editor-font-size, 14px);
                }
                .issue-line {
                    background-color: var(--vscode-diffEditor-insertedLineBackground);
                }
                h1 {
                    color: white;
                    font-size: 1.5em;
                }
                h2 {
                    color: white;
                    font-size: 1.2em;
                }
                .file-path {
                    color: white;
                    font-size: 0.9em;
                    word-break: break-all;
                }
                a {
                    color: var(--vscode-textLink-foreground);
                }
                ::-webkit-scrollbar {
                    width: 10px;
                }
                ::-webkit-scrollbar-track {
                    background: var(--vscode-scrollbarSlider-background);
                }
                ::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                }
                ::-webkit-scrollbar-thumb:hover {
                    background: var(--vscode-scrollbarSlider-activeBackground);
                }
            </style>
        </head>
        <body>
            <h1>SonarCloud Issues para ${projectId} (Branch: ${branch})</h1>
            ${filesHtml}
        </body>
        </html>
    `;
}

async function fetchIssuesForFile(projectId, branch, token, filePath) {
    // Remove a parte do caminho que vem antes do nome do projeto
    const projectPath = filePath.substring(filePath.indexOf(projectId));
    
    // Constrói a chave do componente
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
                    resolve(issuesData.issues);
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

    if (lastAnalyzedCommit !== currentCommit) {
        warningMessage = 'O arquivo local pode estar desatualizado em relação à última análise do SonarCloud. ';
        if (isFileModifiedSinceCommit(filePath, lastAnalyzedCommit)) {
            warningMessage += 'Além disso, há modificações locais não analisadas. ';
        }
        warningMessage += 'Considere fazer commit, push e aguardar uma nova análise antes de adicionar os comentários.';
        
        const choice = await vscode.window.showWarningMessage(warningMessage, 'Continuar Mesmo Assim', 'Cancelar');
        if (choice === 'Cancelar') {
            return;
        }
    }

    const edit = new vscode.WorkspaceEdit();
    const documentText = document.getText();

    // Remover comentários existentes do SonarCloud
    const sonarCloudCommentRegex = /^.*\/\/\s*SonarCloud:.*$/gm;
    const cleanedText = documentText.replace(sonarCloudCommentRegex, '');

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(documentText.length)
    );
    edit.replace(document.uri, fullRange, cleanedText);

    // Adicionar novos comentários
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
                        resolve(null);
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

function deactivate() {
    console.log('Extensão SonarCloudViewer desativada');
}

module.exports = {
    activate,
    deactivate
};