const vscode = require('vscode');
const https = require('https');
const path = require('path');
const { getCurrentGitBranch, getProjectIdFromConfig, getAccessToken } = require('./utils');

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

    updateLastOpenedFilePath();

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

        currentPanel.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'requestCurrentFilePath':
                        currentPanel.webview.postMessage({ type: 'updateCurrentFilePath', filePath: lastOpenedFilePath });
                        break;
                }
            },
            undefined,
            context.subscriptions
        );
    }

    console.log('Atualizando conteúdo do WebView');
    await updateWebviewContent(currentPanel, projectId, branch, token);

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
    } else {
        const lastOpenedFile = vscode.workspace.textDocuments[vscode.workspace.textDocuments.length - 1];
        if (lastOpenedFile) {
            const uri = lastOpenedFile.uri;
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (workspaceFolder) {
                lastOpenedFilePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
            }
        }
    }
    console.log(`Último arquivo aberto atualizado: ${lastOpenedFilePath}`);
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
    const severities = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'];
    
    const severitiesWithIssues = new Set(
        Object.values(issuesByFile).flatMap(fileIssues => 
            fileIssues.map(issue => issue.severity)
        )
    );

    const severityCheckboxes = severities.map(severity => `
        <label class="severity-checkbox ${!severitiesWithIssues.has(severity) ? 'disabled' : ''}">
            <input type="checkbox" value="${severity}" 
                   ${severitiesWithIssues.has(severity) ? 'checked' : 'disabled'}>
            <span class="checkmark"></span>
            ${severity}
        </label>
    `).join('');

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
        const filePath = fileKey.split(':').pop();

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
                        const previousLineIndentation = line.match(/^\s*/)[0];
                        lineHtml += `<div class="issue-line">${escapeHtml(`${previousLineIndentation}// ${issue.rule} - ${issue.message}`)}</div>`;
                    }

                    lineHtml += `<div class="${isIssueLine ? 'issue-line' : ''}">${escapeHtml(line)}</div>`;

                    return lineHtml;
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

        return issuesHtml ? `
            <div class="file" data-severities="${[...new Set(fileIssues.map(issue => issue.severity))].join(',')}" data-file-path="${filePath}">
                <h2 class="file-path">${filePath}</h2>
                ${issuesHtml}
            </div>
        ` : '';
    }).join('');

    const hasAnyIssues = Object.values(issuesByFile).some(issues => issues.length > 0);

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
                .code-container {
                    position: relative;
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
                    color: var(--vscode-foreground);
                    font-size: 1.5em;
                }
                h2 {
                    color: var(--vscode-foreground);
                    font-size: 1.2em;
                }
                .file-path {
                    color: var(--vscode-foreground);
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
                .copy-button {
                    position: absolute;
                    top: 5px;
                    right: 5px;
                    background-color: transparent;
                    border: none;
                    cursor: pointer;
                    font-size: 16px;
                    padding: 2px 5px;
                    opacity: 0.7;
                    transition: opacity 0.2s;
                }
                .copy-button:hover {
                    opacity: 1;
                }
                #severity-filter {
                    margin-bottom: 20px;
                    display: flex;
                    flex-wrap: wrap;
                    gap: 10px;
                    align-items: center;
                }
                .severity-checkbox {
                    display: inline-flex;
                    align-items: center;
                    position: relative;
                    padding-left: 30px;
                    cursor: pointer;
                    font-size: 14px;
                }
                .severity-checkbox input {
                    position: absolute;
                    opacity: 0;
                    cursor: pointer;
                    height: 0;
                    width: 0;
                }
                .checkmark {
                    position: absolute;
                    left: 0;
                    height: 20px;
                    width: 20px;
                    background-color: var(--vscode-checkbox-background);
                    border: 1px solid var(--vscode-checkbox-border);
                    border-radius: 3px;
                }
                .severity-checkbox:hover input ~ .checkmark {
                    background-color: var(--vscode-checkbox-selectBackground);
                }
                .severity-checkbox input:checked ~ .checkmark {
                    background-color: var(--vscode-checkbox-selectBackground);
                }
                .checkmark:after {
                    content: "";
                    position: absolute;
                    display: none;
                }
                .severity-checkbox input:checked ~ .checkmark:after {
                    display: block;
                }
                .severity-checkbox .checkmark:after {
                    left: 6px;
                    top: 2px;
                    width: 5px;
                    height: 10px;
                    border: solid var(--vscode-checkbox-foreground);
                    border-width: 0 2px 2px 0;
                    transform: rotate(45deg);
                }
                .hidden {
                    display: none;
                }
                .no-issues-message {
                    background-color: var(--vscode-editorInfo-background);
                    color: var(--vscode-editorInfo-foreground);
                    padding: 10px;
                    margin: 10px 0;
                    border-radius: 5px;
                }
                .severity-checkbox.disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .severity-checkbox.disabled input {
                    cursor: not-allowed;
                }
                .search-container {
                    display: flex;
                    align-items: center;
                    margin-bottom: 20px;
                }
                #file-search {
                    flex-grow: 1;
                    margin-right: 10px;
                    padding: 8px;
                    font-size: 16px;
                    border: 1px solid var(--vscode-input-border);
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                }
                #file-search::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                }
                .auto-search-toggle {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 30px;
                    height: 30px;
                    cursor: pointer;
                    background-color: var(--vscode-button-background);
                    border: none;
                    border-radius: 4px;
                    transition: all 0.1s ease;
                    position: relative;
                    top: 0;
                    box-shadow: 0 2px 0 var(--vscode-button-hoverBackground);
                }
                .auto-search-toggle:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .auto-search-toggle input {
                    display: none;
                }
                .auto-search-toggle .icon {
                    font-size: 18px;
                    color: var(--vscode-button-foreground);
                    transition: all 0.1s ease;
                }
                .auto-search-toggle.active {
                    background-color: var(--vscode-inputOption-activeBackground);
                    top: 2px;
                    box-shadow: 0 0 0 var(--vscode-button-hoverBackground);
                }
                .auto-search-toggle.active .icon {
                    color: var(--vscode-inputOption-activeForeground);
                }
            </style>
        </head>
        <body>
            <h1>SonarCloud Issues para ${projectId} (Branch: ${branch})</h1>
            <div class="search-container">
                <input type="text" id="file-search" placeholder="Pesquisar arquivos...">
                <label class="auto-search-toggle" title="Busca automática do arquivo atual">
                    <input type="checkbox" id="auto-search-toggle">
                    <span class="icon">📑</span>
                </label>
            </div>
            <div id="severity-filter">
                <span>Filtrar por Severidade:</span>
                ${severityCheckboxes}
            </div>
            <div id="no-issues-message" class="no-issues-message" style="display: ${hasAnyIssues ? 'none' : 'block'};">
                ${hasAnyIssues ? '' : 'Nenhuma issue encontrada para este projeto/branch.'}
            </div>
            <div id="files-container">
                ${filesHtml}
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const severityFilter = document.getElementById('severity-filter');
                const filesContainer = document.getElementById('files-container');
                const noIssuesMessage = document.getElementById('no-issues-message');
                const fileSearch = document.getElementById('file-search');
                const autoSearchToggle = document.getElementById('auto-search-toggle');
                const autoSearchToggleLabel = document.querySelector('.auto-search-toggle');

                let lastReceivedFilePath = '';
                let isAutoUpdateEnabled = false;

                function escapeRegExp(string) {
                    return string.replace(/[.*+?^{}()|[\]\\]/g, '\\$&');
                }

                function createFlexiblePathRegex(path) {
                    path = path.replace(/\\\\/g, '/');
                    const parts = path.split(/[\\/]+/).filter(Boolean);
                    const pattern = parts.map(part => '(?=.*' + escapeRegExp(part) + ')').join('');
                    return new RegExp(pattern, 'i');
                }

                function filterIssues() {
                    const selectedSeverities = Array.from(severityFilter.querySelectorAll('input:checked:not(:disabled)'))
                        .map(checkbox => checkbox.value);
                    const searchTerm = fileSearch.value.trim();
                    const searchRegex = createFlexiblePathRegex(searchTerm);
                    const files = filesContainer.getElementsByClassName('file');
                    let hasVisibleIssues = false;
                    
                    Array.from(files).forEach(file => {
                        const fileSeverities = file.dataset.severities.split(',');
                        const fileHasSelectedSeverity = fileSeverities.some(severity => selectedSeverities.includes(severity));
                        const filePath = file.dataset.filePath;
                        const fileMatchesSearch = searchTerm === '' || searchRegex.test(filePath);
                        
                        const isVisible = fileHasSelectedSeverity && fileMatchesSearch;
                        file.classList.toggle('hidden', !isVisible);
                        
                        if (isVisible) {
                            const issues = file.getElementsByClassName('issue');
                            Array.from(issues).forEach(issue => {
                                const issueSeverity = issue.dataset.severity;
                                const issueVisible = selectedSeverities.includes(issueSeverity);
                                issue.classList.toggle('hidden', !issueVisible);
                                if (issueVisible) hasVisibleIssues = true;
                            });
                        }
                    });

                    noIssuesMessage.style.display = hasVisibleIssues ? 'none' : 'block';
                    noIssuesMessage.textContent = hasVisibleIssues ? '' : 'Nenhuma issue encontrada para os filtros selecionados.';
                }

                severityFilter.addEventListener('change', filterIssues);
                fileSearch.addEventListener('input', filterIssues);
                
                function updateSearchWithCurrentFile() {
                    vscode.postMessage({ type: 'requestCurrentFilePath' });
                }

                autoSearchToggle.addEventListener('change', function() {
                    isAutoUpdateEnabled = this.checked;
                    autoSearchToggleLabel.classList.toggle('active', isAutoUpdateEnabled);
                    if (isAutoUpdateEnabled && lastReceivedFilePath) {
                        fileSearch.value = lastReceivedFilePath;
                        filterIssues();
                    } else if (!isAutoUpdateEnabled) {
                        fileSearch.value = '';
                        filterIssues();
                    }
                });

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'updateCurrentFilePath':
                            lastReceivedFilePath = message.filePath;
                            if (isAutoUpdateEnabled) {
                                fileSearch.value = lastReceivedFilePath;
                                filterIssues();
                            }
                            break;
                    }
                });

                function copyCode(button) {
                    const codeContainer = button.parentElement;
                    const codeElement = codeContainer.querySelector('code');
                    const textArea = document.createElement('textarea');
                    textArea.value = codeElement.innerText;
                    document.body.appendChild(textArea);
                    textArea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textArea);
                    
                    // Visual feedback
                    const originalText = button.textContent;
                    button.textContent = '✔️';
                    button.style.opacity = '1';
                    setTimeout(() => {
                        button.textContent = originalText;
                        button.style.opacity = '0.7';
                    }, 2000);
                }

                // Solicita o caminho do arquivo atual quando o webview é carregado
                updateSearchWithCurrentFile();
            </script>
        </body>
        </html>
    `;
}

async function updateWebviewContent(panel, projectId, branch, token) {
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

module.exports = {
    showSonarCloudViewer
};