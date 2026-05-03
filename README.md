# 🎵 Blind Test Party — Multijoueur

Application web multijoueur pour animer une soirée blind test. Le **Host** lance les morceaux depuis son PC, les **joueurs** votent depuis leur téléphone pour deviner qui a ajouté le morceau.

## 🎯 Concept

Chacun envoie ses morceaux préférés au Host avant la soirée. Pendant la partie, le Host lance un morceau au hasard et chaque joueur tape sur le téléphone le nom du joueur qu'il pense être l'auteur de ce choix musical. Le Host révèle la réponse, attribue manuellement les points.

## 🏗 Architecture

```
┌─────────────┐  WebSocket  ┌──────────────┐  WebSocket  ┌─────────────┐
│  PC du Host │◄───────────►│   Serveur    │◄───────────►│ Téléphones  │
│  (lecteur)  │             │  Node.js     │             │  (vote)     │
└─────────────┘             │  + Socket.io │             └─────────────┘
                            └──────────────┘
```

Les **MP3 ne quittent jamais le PC du Host** : ils sont lus localement par son navigateur. Le serveur ne fait que relayer les événements de jeu (qui a voté quoi, qui a gagné le point).

## 📁 Structure

```
server/                  Code serveur Node.js
  server.js              Express + Socket.io
  game-state.js          État de la partie en mémoire
  socket-handlers.js     Handlers des événements WebSocket

public/
  shared/                Code partagé Host + Joueur
    events.js            Constantes des événements WebSocket
    utils.js             fmt(), esc(), couleurs
  host/                  Vue Host (PC)
    index.html, styles.css, modules/
  player/                Vue Joueur (mobile)
    index.html, styles.css, modules/
```

## 🚀 Lancement local

Prérequis : **Node.js 18+**

```bash
npm install
npm start
```

Puis ouvrir :
- **Host** : http://localhost:3000
- **Joueur** : http://localhost:3000/player

Pour que les téléphones du même WiFi puissent se connecter, remplacer `localhost` par l'IP locale du PC (ex: `http://192.168.1.42:3000/player`).

## 🌐 Déploiement Render

1. Pousser le projet sur GitHub
2. Sur [render.com](https://render.com) → **New Web Service** → connecter le repo
3. Paramètres :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Environment** : Node
4. Render attribue une URL publique du type `https://blindtest-xyz.onrender.com`

## 🧩 Ajouter une fonctionnalité

Tous les événements WebSocket sont déclarés dans `public/shared/events.js`. Pour ajouter un nouveau message :

1. Ajouter la constante dans `events.js`
2. Émettre côté client (host ou player)
3. Handler côté serveur dans `server/socket-handlers.js`
4. Réception côté autre client

## ⌨️ Raccourcis Host

| Touche | Action |
|--------|--------|
| `Espace` | Play / Pause |
| `←` / `→` | Morceau précédent / suivant |
| `R` | Morceau aléatoire |
| `K` | Aller au moment clé |
| `M` | Définir moment clé ici |
| `Échap` | Fermer modale / révélation |
