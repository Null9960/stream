FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy addon files
COPY addon.js ./
COPY server.js ./

# Expose the default port
EXPOSE 7000

# Set environment variables
ENV PORT=7000
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:7000/manifest.json || exit 1

# Start the addon
CMD ["node", "server.js"]
