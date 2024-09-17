const vscode = require('vscode');
const path = require('path');
const fs = require('fs').promises;
const { 
    getCurrentGitBranch, 
    getProjectIdFromConfig, 
    getSonarCloudAccessToken,
    fetchIssues,
    groupIssuesByFile,
    fetchSourceForFiles
} = require('./utils');

let currentPanel = undefined;
let lastOpenedFilePath = '';

async function showSonarCloudViewer(context, lastUsedBranch) {
    console.log('Comando showSonarCloudViewer iniciado');

    const projectId = await getProjectIdFromConfig();
    console.log(`ProjectId obtido: ${projectId}`);

    if (!projectId) {
        console.error('ID do projeto SonarCloud não encontrado.');
        vscode.window.showErrorMessage('ID do projeto SonarCloud não encontrado.');
        return lastUsedBranch;
    }

    let sonarCloudAccessToken = await getSonarCloudAccessToken();
    if (!sonarCloudAccessToken) {
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

    updateLastOpenedFilePath();

    if (currentPanel) {
        console.log('Painel existente encontrado, revelando-o');
        currentPanel.reveal(vscode.ViewColumn.Two);
    } else {
        console.log('Criando novo painel WebView');
        currentPanel = vscode.window.createWebviewPanel(
            'sonarCloudViewer',
            'SonarCloud Viewer',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath))]
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

        currentPanel.webview.onDidReceiveMessage(
            message => {
                if (message.type === 'requestCurrentFilePath') {
                    currentPanel.webview.postMessage({ type: 'updateCurrentFilePath', filePath: lastOpenedFilePath });
                }
            },
            undefined,
            context.subscriptions
        );
    }

    console.log('Atualizando conteúdo do WebView');
    await updateWebviewContent(currentPanel, projectId, branch, sonarCloudAccessToken, context);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            updateLastOpenedFilePath();
            if (currentPanel) {
                currentPanel.webview.postMessage({ type: 'updateCurrentFilePath', filePath: lastOpenedFilePath });
            }
        })
    );

    return lastUsedBranch;
}

function updateLastOpenedFilePath() {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const uri = activeEditor.document.uri;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (workspaceFolder) {
            lastOpenedFilePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
        }
    }
    
    console.log(`Último arquivo aberto atualizado: ${lastOpenedFilePath}`);
}

async function updateWebviewContent(panel, projectId, branch, token, context) {
    try {
        const issues = await fetchIssues(projectId, branch, token);
        const issuesByFile = groupIssuesByFile(issues);
        const filesWithSource = await fetchSourceForFiles(projectId, branch, token, Object.keys(issuesByFile));

        const htmlPath = vscode.Uri.file(path.join(context.extensionPath, 'sonarCloudViewer.html'));
        const jsPath = vscode.Uri.file(path.join(context.extensionPath, 'sonarCloudViewer.js'));
        const cssPath = vscode.Uri.file(path.join(context.extensionPath, 'sonarCloudViewer.css'));

        let htmlContent = await fs.readFile(htmlPath.fsPath, 'utf8');

        const cssUri = panel.webview.asWebviewUri(cssPath);
        const scriptUri = panel.webview.asWebviewUri(jsPath);

        const filesHtml = generateFilesHtml(issuesByFile, filesWithSource);
        const hasAnyIssues = Object.values(issuesByFile).some(issues => issues.length > 0);

        const replacements = {
            '#{cssUri}#': cssUri,
            '#{scriptUri}#': scriptUri,
            '#{projectId}#': projectId,
            '#{branch}#': branch,
            '#{severityCheckboxes}#': '', // Removido, agora é gerado no cliente
            '#{hasAnyIssues}#': hasAnyIssues ? 'none' : 'block',
            '#{noIssuesMessage}#': hasAnyIssues ? '' : 'Nenhuma issue encontrada para este projeto/branch.',
            '#{filesHtml}#': filesHtml
        };

        for (const [placeholder, value] of Object.entries(replacements)) {
            htmlContent = htmlContent.replace(new RegExp(placeholder, 'g'), value);
        }

        panel.webview.html = htmlContent;
    } catch (error) {
        console.error('Erro ao buscar dados do SonarCloud:', error);
        panel.webview.html = `
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
}

function generateFilesHtml(issuesByFile, filesWithSource) {
    return Object.entries(issuesByFile).map(([fileKey, fileIssues]) => {
        const sourceLines = filesWithSource[fileKey] || [];
        const filePath = fileKey.split(':').pop();

        const issuesHtml = fileIssues
            .filter(issue => issue.line !== undefined)
            .map(issue => {
                const issueLine = issue.line;
                const startLine = Math.max(1, issueLine - 2);
                const endLine = Math.min(sourceLines.length, issueLine + 2);

                const codeSnippet = sourceLines.slice(startLine - 1, endLine)
                    .map((line, index) => {
                        const lineNumber = startLine + index;
                        const isIssueLine = lineNumber === issueLine;
                        return `<div class="${isIssueLine ? 'issue-line' : ''}">${escapeHtml(line)}</div>`;
                    }).join('');

                return `
                    <div class="issue" data-severity="${issue.severity}">
                        <p class="issue-header">
                            <strong>Código: ${issue.rule}</strong>
                            <span class="issue-meta">Tipo: ${issue.type}, Severidade: ${issue.severity}</span>
                        </p>
                        <div class="code-container">
                            <pre><code>${codeSnippet}</code></pre>
                            <button class="copy-button" onclick="copyCode(this)" title="Copiar código">📄</button>
                        </div>
                    </div>
                `;
            }).join('');

        return `
            <div class="file" data-severities="${[...new Set(fileIssues.map(issue => issue.severity))].join(',')}" data-file-path="${filePath}">
                <h2 class="file-path">${filePath}</h2>
                ${issuesHtml}
            </div>
        `;
    }).join('');
}

function escapeHtml(unsafe) {
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
}

module.exports = {
    showSonarCloudViewer
};