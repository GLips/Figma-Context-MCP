# Build stage
FROM node:20.17.0-slim AS builder

# Set working directory
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy package files first
COPY package.json pnpm-lock.yaml* ./

# Install all dependencies
RUN pnpm install --ignore-scripts

# Copy the rest of the project files
COPY . .

# Use the existing script prepare that already includes build and chmod
RUN pnpm run prepare

# Production stage - much lighter image
FROM node:20.17.0-alpine AS production

# Set working directory
WORKDIR /app

# Install pnpm in production image (only what's needed)
RUN npm install -g pnpm

# Copy only package.json and pnpm-lock.yaml for installing production dependencies
COPY package.json pnpm-lock.yaml* ./

# Install only production dependencies
RUN pnpm install --prod --ignore-scripts

# Copy compiled code from build stage
COPY --from=builder /app/dist /app/dist

# Expose port defined in environment variables (default 3333)
EXPOSE 3333

# Command to start the application
CMD ["pnpm", "start:http"] 