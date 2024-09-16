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
    await updateWebviewContent(currentPanel, projectId, branch, token, context);

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

function ensurePanelVisibility() {
    if (currentPanel) {
        const editors = vscode.window.visibleTextEditors;
        const panelColumn = currentPanel.viewColumn;

        if (panelColumn !== vscode.ViewColumn.Beside) {
            currentPanel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }

        const editorInSameGroup = editors.find(editor => editor.viewColumn === panelColumn);

        if (editorInSameGroup) {
            vscode.window.showTextDocument(editorInSameGroup.document, {
                viewColumn: vscode.ViewColumn.One
            }).then(() => {
                currentPanel.reveal(vscode.ViewColumn.Beside, true);
            });
        }
    }
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

function getWebviewContent(projectId, branch, issuesByFile, filesWithSource, context) {
    const severities = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'];
    
    const severitiesWithIssues = new Set(
        Object.values(issuesByFile).flatMap(fileIssues => 
            fileIssues.map(issue => issue.severity)
        )
    );

    const severityCheckboxes = severities.map(severity => `
        <label class="severity-checkbox ${!severitiesWithIssues.has(severity) ? 'disabled' : ''}">
            <input type="checkbox" value="${severity}" 
                   ${severitiesWithIssues.has(severity) ? 'checked' : ''}
                   ${!severitiesWithIssues.has(severity) ? 'disabled' : ''}>
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

    const cssPath = vscode.Uri.file(path.join(context.extensionPath, 'styles.css'));

    const cssSrc = currentPanel.webview.asWebviewUri(cssPath);

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>SonarCloud Viewer</title>
            <link rel="stylesheet" href="${cssSrc}">
        </head>
        <body>
            <h1>SonarCloud Issues para ${projectId} (Branch: ${branch})</h1>
            <div class="search-container">
                <input type="text" id="file-search" placeholder="Pesquisar arquivos...">
                <button id="clear-filter-btn" title="Limpar filtro">
                    <span class="icon">🧹</span>
                </button>
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
                const clearFilterBtn = document.getElementById('clear-filter-btn');

                let lastReceivedFilePath = '';

                function escapeRegExp(string) {
                    return string.replace(/[.*+?^{}()|[\]\\]/g, '\\$&');
                }

                function createFlexiblePathRegex(path) {
                    path = path.replace(/\\\\/g, '/');
                    const parts = path.split(/[\\/]+/).filter(Boolean);
                    const pattern = parts.map(part => '(?=.*' + escapeRegExp(part) + ')').join('');
                    return new RegExp(pattern, 'i');
                }

                function updateSeverityCheckboxes(availableSeverities) {
                    const checkboxes = severityFilter.querySelectorAll('input[type="checkbox"]');
                    checkboxes.forEach(checkbox => {
                        const severity = checkbox.value;
                        const isAvailable = availableSeverities.has(severity);
                        checkbox.disabled = !isAvailable;
                        checkbox.checked = isAvailable;
                        checkbox.parentElement.classList.toggle('disabled', !isAvailable);
                    });
                }

                function filterIssues() {
                    const searchTerm = fileSearch.value.trim();
                    const searchRegex = createFlexiblePathRegex(searchTerm);
                    const files = filesContainer.getElementsByClassName('file');
                    let hasVisibleIssues = false;
                    const availableSeverities = new Set();
                    
                    Array.from(files).forEach(file => {
                        const filePath = file.dataset.filePath;
                        const fileMatchesSearch = searchTerm === '' || searchRegex.test(filePath);
                        
                        if (fileMatchesSearch) {
                            const issues = file.getElementsByClassName('issue');
                            let fileHasVisibleIssues = false;
                            
                            Array.from(issues).forEach(issue => {
                                const issueSeverity = issue.dataset.severity;
                                availableSeverities.add(issueSeverity);
                                issue.classList.remove('hidden');
                                fileHasVisibleIssues = true;
                                hasVisibleIssues = true;
                            });
                            
                            file.classList.toggle('hidden', !fileHasVisibleIssues);
                        } else {
                            file.classList.add('hidden');
                        }
                    });

                    updateSeverityCheckboxes(availableSeverities);
                    applySeverityFilter();
                }

                function applySeverityFilter() {
                    const selectedSeverities = Array.from(severityFilter.querySelectorAll('input:checked:not(:disabled)'))
                        .map(checkbox => checkbox.value);
                    
                    const files = filesContainer.getElementsByClassName('file');
                    let hasVisibleIssues = false;

                    Array.from(files).forEach(file => {
                        if (!file.classList.contains('hidden')) {
                            const issues = file.getElementsByClassName('issue');
                            let fileHasVisibleIssues = false;

                            Array.from(issues).forEach(issue => {
                                const issueSeverity = issue.dataset.severity;
                                const issueVisible = selectedSeverities.includes(issueSeverity);
                                issue.classList.toggle('hidden', !issueVisible);
                                if (issueVisible) {
                                    fileHasVisibleIssues = true;
                                    hasVisibleIssues = true;
                                }
                            });

                            file.classList.toggle('hidden', !fileHasVisibleIssues);
                        }
                    });

                    noIssuesMessage.style.display = hasVisibleIssues ? 'none' : 'block';
                    noIssuesMessage.textContent = hasVisibleIssues ? '' : 'Nenhuma issue encontrada para os filtros selecionados.';
                }

                severityFilter.addEventListener('change', applySeverityFilter);
                fileSearch.addEventListener('input', filterIssues);

                clearFilterBtn.addEventListener('click', () => {
                    fileSearch.value = '';
                    filterIssues();
                });

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'updateCurrentFilePath':
                            lastReceivedFilePath = message.filePath;
                            fileSearch.value = lastReceivedFilePath;
                            filterIssues();
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
                    
                    const originalText = button.textContent;
                    button.textContent = '✔️';
                    button.style.opacity = '1';
                    setTimeout(() => {
                        button.textContent = originalText;
                        button.style.opacity = '0.7';
                    }, 2000);
                }

                vscode.postMessage({ type: 'requestCurrentFilePath' });
            </script>
        </body>
        </html>
    `;
}

async function updateWebviewContent(panel, projectId, branch, token, context) {
    panel.webview.html = `
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

    try {
        const issues = await fetchIssues(projectId, branch, token);
        const issuesByFile = groupIssuesByFile(issues);
        const filesWithSource = await fetchSourceForFiles(projectId, branch, token, Object.keys(issuesByFile));
        panel.webview.html = getWebviewContent(projectId, branch, issuesByFile, filesWithSource, context);
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

module.exports = {
    showSonarCloudViewer
};