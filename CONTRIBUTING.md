# Contributing to Framelink Figma MCP Server

Thank you for your interest in contributing to the Framelink Figma MCP Server! This guide will help you get started with contributing to this project.

## Philosophy

### Unix Philosophy for Tools

This project adheres to the Unix philosophy: tools should have one job and few arguments. We keep our tools as simple as possible to avoid confusing LLMs during calling. Configurable options that are more project-level (i.e., unlikely to change between requests for Figma data) are best set as command line arguments rather than being exposed as tool parameters.

### MCP Server Scope

The MCP server should only focus on **ingesting designs for AI consumption**. This is our core responsibility and what we do best. Additional features are best handled externally by other specialized tools. Examples of features that would be out of scope include:

- Image conversion, cropping, or other image manipulation
- Syncing design data to CMSes or databases
- Code generation or framework-specific output
- Third-party integrations unrelated to design ingestion

This focused approach ensures:

- Clear boundaries and responsibilities
- Better maintainability
- Easier testing and debugging
- More reliable integration with AI tools

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher
- pnpm (recommended package manager)
- A Figma API access token ([how to create one](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens))

### Development Setup

1. **Clone the repository:**

   ```bash
   git clone https://github.com/GLips/Figma-Context-MCP.git
   cd Figma-Context-MCP
   ```

2. **Install dependencies:**

   ```bash
   pnpm install
   ```

3. **Set up environment variables:**
   Create a `.env` file in the root directory:

   ```
   FIGMA_API_KEY=your_figma_api_key_here
   ```

4. **Build the project:**

   ```bash
   pnpm build
   ```

5. **Run tests:**

   ```bash
   pnpm test
   ```

6. **Start development server:**

   ```bash
   pnpm dev
   ```

7. **Test locally:**

   `pnpm dev` will start a local server you can connect to via Streamable HTTP. To connect to it, you can add the following configuration to your MCP JSON config file. Note, some MCP clients use a different format. [See the Framelink docs](https://www.framelink.ai/docs/quickstart#configure-ide) for more information on specific clients.

   ```bash
   "mcpServers": {
      "Framelink Figma MCP - Local StreamableHTTP": {
         "url": "http://localhost:3333/mcp"
      },
   }
   ```

### Development Commands

- `pnpm dev` - Start development server with watch mode
- `pnpm build` - Build the project
- `pnpm type-check` - Run TypeScript type checking
- `pnpm test` - Run tests
- `pnpm lint` - Run ESLint
- `pnpm format` - Format code with Prettier
- `pnpm inspect` - Run MCP inspector for debugging

## Code Style and Standards

### TypeScript

- Use TypeScript for all new code
- Follow TypeScript settings as defined in `tsconfig.json`

### Code Formatting

- Use Prettier for code formatting (run `pnpm format`)
- Use ESLint for code linting (run `pnpm lint`)
- Follow existing code patterns and conventions

## Project Structure

```
src/
├── cli.ts              # Command line interface
├── config.ts           # Configuration management
├── index.ts            # Main entry point
├── server.ts           # MCP server implementation
├── mcp/                # MCP-specific code
│   ├── index.ts
│   └── tools/          # MCP tools
├── services/           # Core business logic
├── transformers/       # Data transformation logic
├── utils/              # Utility functions
└── tests/              # Test files
```

## Contributing Guidelines

### Before You Start

1. Check existing issues and PRs to avoid duplicates
2. For major changes, create an issue first to discuss the approach
3. Keep changes focused and atomic

### Pull Request Process

1. **Fork the repository** and create a feature branch
2. **Make your changes** following the code style guidelines
3. **Add tests** for new functionality
4. **Run the test suite** to ensure nothing is broken:
   ```bash
   pnpm test
   pnpm type-check
   pnpm lint
   ```
5. **Update documentation** if needed
6. **Submit a pull request** with a clear description that includes context and motivation for the changes

### Commit Messages

- Use clear, descriptive commit messages
- Follow conventional commit format when possible
- Reference issue numbers when applicable

### What We're Looking For

- **New features** - Expand the server's capabilities to support more Figma features
- **Bug fixes** - Help us improve reliability
- **Performance improvements** - Make the server faster
- **Documentation improvements** - Help others understand the project
- **Test coverage** - Improve our test suite
- **Code quality** - Refactoring and clean-up

### What We're Not Looking For

- Features that go beyond design ingestion (see Philosophy section)
- Breaking changes without discussion
- Code that doesn't follow our style guidelines
- Features without tests

## Getting Help

- **Documentation**: Check the [Framelink docs](https://framelink.ai/docs)
- **Issues**: Search existing issues or create a new one
- **Discord**: Join our [Discord community](https://framelink.ai/discord)

## License

By contributing to this project, you agree that your contributions will be licensed under the MIT License.
