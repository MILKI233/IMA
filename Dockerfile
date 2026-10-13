FROM node:20-bookworm-slim

# כלי בנייה — גיבוי למקרה שאין בינארי מוכן מראש ל-better-sqlite3 בפלטפורמה הזו
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV GEMACH_DATA_DIR=/data
# בלי זה, "localtime" ב-SQLite (ובתיאורי זמן יחסיים כמו "לפני X דקות") מחושב לפי UTC
ENV TZ=Asia/Jerusalem
EXPOSE 3900

CMD ["node", "server.js"]
