const vscode = require('vscode');
const { 
    getCurrentGitBranch, 
    getProjectIdFromConfig, 
    getSonarCloudAccessToken, 
    getStackSpotClientId, 
    getStackSpotClientKey,
    getClientCredentialsToken,
    executeRemoteQuickCommand,
    getQuickCommandResult,
    extractCodeBlock,
    fetchIssues,
    fetchSourceForFiles
} = require('./utils');

// Configuration for the application
let config = {
    clientId: '',
    clientSecret: ''
};

async function initializeConfig() {
    config.clientId = await getStackSpotClientId();
    config.clientSecret = await getStackSpotClientKey();
}

// Function to resolve SonarCloud issues
async function resolveSonarIssuesInCurrentFile(lastUsedBranch) {
    console.log('Starting SonarCloud issue resolution');

    const steps = [
        "Iniciando resolução de problemas",
        "Obtendo token de acesso",
        "Buscando issues do SonarCloud",
        "Comentando o código",
        "Executando comando remoto",
        "Aguardando resultado",
        "Aplicando mudanças"
    ];
    
    const totalSteps = steps.length;

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No file open to resolve issues.');
        return lastUsedBranch;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Resolvendo problemas do SonarCloud",
        cancellable: false
    }, async (progress) => {
        try {
            let currentStep = 0;
            const incrementProgress = (message) => {
                currentStep++;
                progress.report({ increment: (100 / totalSteps), message });
            };

            incrementProgress(steps[0]);

            incrementProgress(steps[1]);
            console.log('Obtaining access token');
            await initializeConfig();
            const token = await getClientCredentialsToken(config.clientId, config.clientSecret);
            console.log('Access token obtained');

            const document = editor.document;
            const fileContent = document.getText();

            incrementProgress(steps[2]);
            const projectId = await getProjectIdFromConfig();
            const branch = await getCurrentGitBranch();
            const sonarToken = await getSonarCloudAccessToken();
            const issues = await fetchIssues(projectId, branch, sonarToken);

            incrementProgress(steps[3]);
            const commentedContent = await commentCodeWithIssues(document, issues, projectId, branch, sonarToken);

            incrementProgress(steps[4]);
            console.log('Executing remote quick command');
            const executionId = await executeRemoteQuickCommand(token, commentedContent);
            console.log(`Remote quick command execution started with ID: ${executionId}`);

            incrementProgress(steps[5]);
            let result = null;
            let attempts = 0;
            const maxAttempts = 30; // 5 minutes timeout (10 seconds * 30 attempts)

            while (!result && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds
                result = await getQuickCommandResult(token, executionId);
                attempts++;
                progress.report({ message: `${steps[5]} (tentativa ${attempts})` });
            }

            if (result && result.progress.status === 'COMPLETED') {
                incrementProgress(steps[6]);
                console.log('Remote quick command result received');
                const resolvedContent = extractCodeBlock(result.result);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(
                    document.uri,
                    new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    ),
                    resolvedContent
                );
                await vscode.workspace.applyEdit(edit);

                vscode.window.showInformationMessage('SonarCloud issues resolved successfully.');
            } else {
                throw new Error('Failed to resolve SonarCloud issues. Timeout or execution failed.');
            }

        } catch (error) {
            console.error('Error resolving SonarCloud issues:', error);
            vscode.window.showErrorMessage(`Error resolving SonarCloud issues: ${error.message}`);
        }
    });

    return lastUsedBranch;
}

async function commentCodeWithIssues(document, issues, projectId, branch, token) {
    const fileUri = document.uri;
    const filePath = fileUri.path;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    let relativePath = filePath;
    if (workspaceFolders) {
        const workspacePath = workspaceFolders[0].uri.fsPath;
        relativePath = filePath.replace(workspacePath, '');
    }

    const projectPath = relativePath.substring(relativePath.indexOf(projectId));
    const componentKey = `${projectId}:${projectPath}`;

    const fileIssues = issues.filter(issue => issue.component === componentKey);
    const filesWithSource = await fetchSourceForFiles(projectId, branch, token, [componentKey]);
    const sourceLines = filesWithSource[componentKey] || document.getText().split('\n');

    let commentedLines = [...sourceLines];
    for (const issue of fileIssues) {
        if (issue.line) {
            const commentText = `// SonarCloud: ${issue.rule} - ${issue.message}`;
            commentedLines.splice(issue.line - 1, 0, commentText);
        }
    }

    return commentedLines.join('\n');
}

module.exports = {
    resolveSonarIssuesInCurrentFile
};