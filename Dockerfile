FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY account-api.js ./
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
