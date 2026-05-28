# 🤖 Stremio Addon — Legendas PT-BR com IA

Addon que busca legendas em inglês no OpenSubtitles e traduz automaticamente para **Português Brasileiro** usando o Claude (Anthropic).

---

## Fluxo completo

```
Stremio pede legenda
      ↓
Busca no OpenSubtitles (inglês)
      ↓
Baixa o arquivo .srt
      ↓
Divide em chunks e traduz com Claude
      ↓
Serve o .srt traduzido para o Stremio
```

---

## Configuração

### 1. Instale as dependências

```bash
npm install
```

### 2. Configure as chaves de API

Edite o arquivo `index.js` ou use variáveis de ambiente:

| Variável | Como obter |
|----------|-----------|
| `OPENSUBTITLES_API_KEY` | Crie uma conta em [opensubtitles.com](https://www.opensubtitles.com/consumers) → Consumers → New consumer |
| `ANTHROPIC_API_KEY` | Acesse [console.anthropic.com](https://console.anthropic.com/) → API Keys |

### 3. Inicie o servidor

```bash
# Usando variáveis de ambiente (recomendado)
OPENSUBTITLES_API_KEY=sua_key ANTHROPIC_API_KEY=sua_key npm start

# Ou edite o CONFIG no index.js e rode:
npm start
```

### 4. Adicione no Stremio

1. Abra o Stremio → **Addons**
2. Clique em **Community Addons → Install from URL**
3. Cole: `http://localhost:7000/manifest.json`

---

## Endpoints disponíveis

| Endpoint | Descrição |
|----------|-----------|
| `/manifest.json` | Manifesto do addon |
| `/subtitles/:type/:id.json` | Handler de legendas (chamado pelo Stremio) |
| `/sub/:chave.srt` | Serve o SRT traduzido gerado |
| `/status` | Status do servidor e cache |

---

## Como a tradução funciona

O SRT é dividido em **chunks de 80 blocos** para não ultrapassar o limite de tokens do Claude. Cada chunk é enviado com um prompt que instrui o modelo a:

- Traduzir para PT-BR com linguagem natural e coloquial
- Manter o número de linhas por bloco
- Preservar tags de formatação (`<i>`, `<b>`)
- Não traduzir nomes próprios de personagens

Os blocos são numerados com marcadores `|||N|||` para que a resposta possa ser parseada de forma confiável.

---

## Cache

As legendas traduzidas ficam em memória enquanto o servidor está rodando. Para persistência entre reinicializações, você pode substituir o `Map` por um arquivo JSON ou banco de dados SQLite.

---

## Deploy

Para uso além da máquina local, faça deploy em [Render.com](https://render.com) ou [Railway.app](https://railway.app) e configure as variáveis de ambiente lá.

> **Atenção:** Em produção, troque `http://localhost:7000` pela URL pública do seu servidor na linha que monta a `subUrl`.
