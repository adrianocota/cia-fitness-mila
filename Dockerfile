# Usa Node 22 oficial (resolve o problema do WebSocket do Supabase)
FROM node:22-alpine

# Define diretório de trabalho dentro do container
WORKDIR /app

# Copia arquivos de dependências primeiro (otimização de cache)
COPY package*.json ./

# Instala dependências
RUN npm install --production

# Copia o resto do código
COPY . .

# Porta que o servidor vai escutar
EXPOSE 3000

# Comando pra iniciar o servidor
CMD ["node", "src/server.js"]
