FROM ubuntu:latest

# Update package lists and install dependencies in a single layer to reduce image size
RUN apt-get update && apt-get install -y curl gnupg git

# Install Node.js and npm
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm

# Set working directory
WORKDIR /app

# Clone the repository and install dependencies
RUN git clone https://github.com/GLips/Figma-Context-MCP.git \
    && cd Figma-Context-MCP \
    && pnpm install

# Create startup script
COPY start-service.sh /app/start-service.sh
RUN chmod +x /app/start-service.sh

# Set working directory to the project folder
WORKDIR /app/Figma-Context-MCP

# Default command that will be overridden by the Claude/Cline config
ENTRYPOINT ["bash", "-c"]
CMD ["npx figma-developer-mcp --stdio"]