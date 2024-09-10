const vscode = require('vscode');
const https = require('https');
const { getCurrentGitBranch, getProjectIdFromConfig, getAccessToken } = require('./utils');

// Configuration for the application
const config = {
    clientId: '1e22230e-3d98-4124-81d8-158d006fbd39',
    clientSecret: '8wwhUTl6xGbh75WpR2xVosdjcegw6Wa6y7Osx736nk8EZxfAVbvN61a31Dn2397B',
    tokenUrl: 'https://idm.stackspot.com/zup/oidc/oauth/token'
};

// Function to get client credentials token
async function getClientCredentialsToken() {
    console.log('Obtaining token using client credentials');
    const postData = `client_id=${encodeURIComponent(config.clientId)}&grant_type=client_credentials&client_secret=${encodeURIComponent(config.clientSecret)}`;

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

// Function to execute the remote quick command
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

// Function to get the result of the remote quick command execution
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

// Function to extract code block from the result
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

// Function to resolve SonarCloud issues
async function resolveSonarIssues(lastUsedBranch) {
    console.log('Starting SonarCloud issue resolution');

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No file open to resolve issues.');
        return lastUsedBranch;
    }

    try {
        console.log('Obtaining access token');
        const token = await getClientCredentialsToken();
        console.log('Access token obtained');

        const document = editor.document;
        const fileContent = document.getText();

        console.log('Executing remote quick command');
        const executionId = await executeRemoteQuickCommand(token, fileContent);
        console.log(`Remote quick command execution started with ID: ${executionId}`);

        let result = null;
        let attempts = 0;
        const maxAttempts = 30; // 5 minutes timeout (10 seconds * 30 attempts)

        while (!result && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds
            result = await getQuickCommandResult(token, executionId);
            attempts++;
        }

        if (result && result.progress.status === 'COMPLETED') {
            console.log('Remote quick command result received');
            const resolvedContent = extractCodeBlock(result.result); // The resolved content is in the result field
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
            vscode.window.showErrorMessage('Failed to resolve SonarCloud issues. Timeout or execution failed.');
        }

    } catch (error) {
        console.error('Error resolving SonarCloud issues:', error);
        vscode.window.showErrorMessage(`Error resolving SonarCloud issues: ${error.message}`);
    }

    return lastUsedBranch;
}

module.exports = {
    resolveSonarIssues
};