FROM node:20-alpine
WORKDIR /app
# Copy only package.json and install dependencies first for better caching
COPY package.json ./
RUN npm install
# Copy Prisma schema from root directory and .env for client generation
COPY prisma ./prisma
COPY .env .env
# Copy the rest of the application code (excluding node_modules due to .dockerignore)
COPY . .
# Generate Prisma client after all code is in place
RUN npx prisma generate
EXPOSE 8080
CMD ["npm", "start"]
