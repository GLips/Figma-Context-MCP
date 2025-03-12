# GitLab Integration Example

This example demonstrates how to use the GitLab integration to generate SwiftUI code from a Figma design and commit it directly to a GitLab repository.

## Prerequisites

1. A Figma API access token
2. A GitLab personal access token with API access
3. A GitLab repository where you want to commit the code

## Setup

1. Start the server with GitLab configuration:

```bash
npx figma-developer-mcp --figma-api-key=<your-figma-api-key> --gitlab-token=<your-gitlab-token> --gitlab-base-url=<your-gitlab-base-url> --gitlab-project-id=<your-gitlab-project-id> --gitlab-branch=<your-gitlab-branch>
```

Or set up your `.env` file with the required configuration:

```
FIGMA_API_KEY=your_figma_api_key_here
GITLAB_TOKEN=your_gitlab_token_here
GITLAB_BASE_URL=https://gitlab.com/api/v4
GITLAB_PROJECT_ID=your_project_id_or_path
GITLAB_BRANCH=main
```

## Example Workflow in Cursor

Here's an example of how to use the GitLab integration in Cursor:

1. Connect Cursor to the MCP server as described in the main README.
2. Open Cursor's composer in agent mode.
3. Paste a link to a Figma file, frame, or component.
4. Ask Cursor to generate SwiftUI code and commit it to GitLab:

```
Please generate SwiftUI code for this Figma design and commit it to our GitLab repository in the Components directory with a descriptive commit message.
```

## Available GitLab Tools

The server provides the following GitLab-related MCP tools:

### commit_to_gitlab

Commits generated SwiftUI code to a GitLab repository.

Parameters:
- `filePath` (string): The path where the file should be saved in the repository (e.g., 'Components/Button.swift')
- `content` (string): The content to be committed to the repository
- `commitMessage` (string): The commit message for this change
- `branch` (string, optional): The branch to commit to (defaults to the configured default branch)

### get_gitlab_branches

Gets a list of branches from the GitLab repository.

Parameters: None

### create_gitlab_branch

Creates a new branch in the GitLab repository.

Parameters:
- `branchName` (string): The name of the new branch to create
- `ref` (string, optional): The branch or commit to create from (defaults to the configured default branch)

### get_gitlab_file

Gets a file from the GitLab repository.

Parameters:
- `filePath` (string): The path of the file to retrieve from the repository
- `ref` (string, optional): The branch or commit to get the file from (defaults to the configured default branch)

### list_gitlab_repository

Lists files and directories in the GitLab repository.

Parameters:
- `path` (string, optional): The path in the repository to list (use empty string for root)
- `ref` (string, optional): The branch or commit to list files from (defaults to the configured default branch)
- `recursive` (boolean, optional): Whether to list files recursively (defaults to false)

### test_gitlab_connection

Tests the connection to the GitLab API to help diagnose connection issues.

Parameters: None

## Example Conversation with Cursor

Here's an example conversation with Cursor using the GitLab integration:

**User:**
```
Here's my Figma design for a custom button: https://www.figma.com/file/abcdefg/MyDesign?node-id=123:456

Can you generate SwiftUI code for this button and commit it to our GitLab repository in the Components/Buttons directory with the commit message "Add custom button component from Figma design"?
```

**Cursor:**
```
I'll generate SwiftUI code for your button design and commit it to GitLab. Let me analyze the Figma design first...

[Cursor fetches the Figma design data and generates SwiftUI code]

I've generated the SwiftUI code for your custom button. Here's a preview:

[Preview of the generated code]

Now I'll commit this to your GitLab repository in the Components/Buttons directory.

[Cursor commits the code to GitLab]

✅ Successfully committed the custom button component to your GitLab repository at Components/Buttons/CustomButton.swift with the message "Add custom button component from Figma design".
``` 