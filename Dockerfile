FROM node:20-alpine
WORKDIR /app

# Install deps (cache layer)
COPY package.json ./
RUN npm install

# Prisma schema + env first
COPY prisma ./prisma
COPY .env .env

# App source
COPY src ./src
COPY README.md ./

# Start script
COPY start.sh ./start.sh
RUN chmod +x ./start.sh && npx prisma generate

EXPOSE 8080
CMD ["./start.sh"]
