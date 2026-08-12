FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-draw qpdf chromium && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY ../index.html /site/index.html
COPY ../app.js /site/app.js
EXPOSE 8787
CMD ["node","server.js"]
