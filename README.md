---
title: DavGlasses Relay
emoji: 👓
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
---

# DavGlasses Relay

Relay WebSocket/REST sem estado que conecta o celular ao Desktop através da internet. Ele não recebe prompts de LLM nem armazena histórico; apenas encaminha mensagens para o `desktopId` online.

```powershell
npm install
npm start
```

Em produção, publique com HTTPS/WSS usando o `Dockerfile` ou o botão Blueprint do Render (`render.yaml`). O provedor encerra TLS; a aplicação escuta `PORT` internamente.
