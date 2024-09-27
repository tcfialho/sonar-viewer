# SonarViewer

SonarViewer is a Visual Studio Code extension that integrates SonarCloud analyses directly into your development environment. This extension allows you to view and manage SonarCloud issues without leaving your code editor.

## Features

SonarViewer offers the following key features, accessible through VS Code commands:

1. **Show SonarCloud Viewer**: Opens a dedicated viewer to display SonarCloud issues for your project.
2. **Add Issue Comments to Current File**: Automatically adds SonarCloud issue comments to the file you're currently editing.
3. **Resolve Commented Issues in Current File**: Helps you resolve SonarCloud issues that have been commented in your current file.
4. **Resolve Sonar Issues for Entire Solution**: Provides a solution-wide approach to resolve SonarCloud issues across your entire project.

## Requirements

- Visual Studio Code v1.92.0 or higher
- A SonarCloud account with a configured project
- A StackSpot account
- Git installed and configured in your environment

## Installation

1. Open Visual Studio Code
2. Go to the Extensions view (Ctrl+Shift+X)
3. Search for "SonarViewer"
4. Click Install

## Configuration

Before using the extension, you'll need to configure some information:

1. SonarCloud Access Token
2. StackSpot Client ID
3. StackSpot Client Key
4. StackSpot Realm

This information can be configured in two ways:

### Through VS Code Settings

1. Go to File > Preferences > Settings
2. Search for "SonarViewer"
3. Fill in the fields:
   - `sonarCloudViewer.accessToken`: Your SonarCloud access token
   - `sonarCloudViewer.stackSpotClientId`: Your StackSpot Client ID
   - `sonarCloudViewer.stackSpotClientKey`: Your StackSpot Client Key
   - `sonarCloudViewer.stackSpotRealm`: Your StackSpot Realm

### Through Extension Commands

The extension will prompt for this information the first time you run a command if it's not already configured.

## Usage

The extension adds the following commands to VS Code:

- `SonarViewer: Show Viewer`: Opens the SonarCloud issues viewer
- `SonarViewer: Add Issue Comments to Current File`: Adds SonarCloud issue comments to the current file
- `SonarViewer: Resolve Commented Issues in Current File`: Resolves the commented issues in the current file
- `SonarViewer: Resolve Sonar Issues for Entire Solution`: Resolves SonarCloud issues for the entire solution

You can access these commands through the command palette (Ctrl+Shift+P) by typing "SonarViewer".

## Contributing

Contributions are welcome! Please read the contribution guidelines before submitting pull requests.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Support

If you encounter any problems or have any suggestions, please open an issue on the [GitHub repository](https://github.com/tcfialho/sonar-viewer).