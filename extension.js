const vscode = require('vscode');
const { showSonarCloudViewer } = require('./ShowSonarCloudViewer');
const { addSonarIssueCommentsToCurrentFile } = require('./AddSonarIssueCommentsToCurrentFile');
const { resolveCommentedSonarIssuesInCurrentFile } = require('./ResolveCommentedSonarIssuesInCurrentFile');

let lastUsedBranch = 'master'; // Branch padrão

function activate(context) {
    console.log('Extensão SonarCloudViewer ativada');

    let showSonarCloudViewerDisposable = vscode.commands.registerCommand('sonar-viewer.showSonarCloudViewer', async () => {
        lastUsedBranch = await showSonarCloudViewer(context, lastUsedBranch);
    });

    let addSonarIssueCommentsToCurrentFileDisposable = vscode.commands.registerCommand('sonar-viewer.addSonarIssueCommentsToCurrentFile', async () => {
        lastUsedBranch = await addSonarIssueCommentsToCurrentFile(lastUsedBranch);
    });

    let resolveIssuesDisposable = vscode.commands.registerCommand('sonar-viewer.resolveCommentedSonarIssuesInCurrentFile', async () => {
        lastUsedBranch = await resolveCommentedSonarIssuesInCurrentFile(lastUsedBranch);
    });
    
    context.subscriptions.push(showSonarCloudViewerDisposable, addSonarIssueCommentsToCurrentFileDisposable, resolveIssuesDisposable);
}

function deactivate() {
    console.log('Extensão SonarCloudViewer desativada');
}

module.exports = {
    activate,
    deactivate
};