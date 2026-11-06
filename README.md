# tp-note-1-wtr

Lien github: https://github.com/vithurzen/tp-note-1-wtr

pour lancer: docker compose up --build -d
http://localhost:3000

Les données sont stockées dans data/db.json avec JsonDB

API
utilisateur
GET /api/users
Retourne tous les utilisateurs

produit
GET /api/products
Retourne tous les produits et leurs stocks

commandes
GET /api/orders
Retourne toutes les commandes

GET /api/orders/:id
Retourne une commande

POST /api/orders
Crée une commande
Body : { "userId": 1, "productId": 1, "quantity": 2 }

PATCH /api/orders/:id/status
Modifie le statut d'une commande
Body: { "status": "shipped" }

DELETE /api/orders/:id
Annule une commande en préparation

ServerSent Events
GET /api/events
Flux général des commandes et des stocks

Événements:
    order-created
    order-updated
    order-cancelled
    stock-updated

GET /api/orders/:id/stream
Flux réservé à une commande
Le filtrage est effectué côté serveur
Le serveur utilise:
    Content-Type: text/event-stream
    Cache-Control: no-cache, no-transform
    Connection: keep-alive

Fonctionnalités implementée
F1: utilisateurs, produits et commandes persistés
F2: validation des champs et du stock
F3: transitions de statut dans l'ordre
F4: annulation et restauration du stock
F5: livraison automatique après 20 secondes
F6: API REST avec codes HTTP adaptés
F7: événements SSE nommés
F8: déconnexion des abonnés
F9: suivi d'une commande en temps réel
F10: filtrage côté serveur par commande

Bonus
B1: reprise avec Last-Event-ID
B2: arrêt du flux après livraison ou annulation
B3: reconnexion après 5 secondes
B4: La connexion reste ouverte derrière un proxy qui coupe les connexions inactives au bout de 30 secondes