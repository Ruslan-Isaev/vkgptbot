FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY index.js ./

RUN mkdir -p /app/data

CMD ["node", "index.js"]
