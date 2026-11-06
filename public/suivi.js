const params = new URLSearchParams(window.location.search);
const orderId = Number(params.get("id"));

const statusBox = document.querySelector("#status");
const detailsBox = document.querySelector("#details");
const connectionBox = document.querySelector("#connection");
const historyBox = document.querySelector("#history");

document.querySelector("#order-id").textContent = String(orderId);

const labels = {
  preparing: "En préparation",
  shipped: "Expédiée",
  delivered: "Livrée",
  cancelled: "Annulée"
};

function isFinal(order) {
  return order.status === "delivered" || order.status === "cancelled";
}

function render(order) {
  detailsBox.textContent =
    `Client n°${order.userId} — Produit n°${order.productId} — Quantité : ${order.quantity}`;

  statusBox.textContent = labels[order.status] || order.status;
}

function addHistory(type, order) {
  const li = document.createElement("li");

  li.textContent =
    `${new Date().toLocaleTimeString()} — ${type} : ${labels[order.status]}`;

  historyBox.prepend(li);
}

async function start() {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new Error("Identifiant de commande invalide");
  }

  const response = await fetch(`/api/orders/${orderId}`);

  if (!response.ok) {
    throw new Error(`Commande n°${orderId} introuvable`);
  }

  const order = await response.json();
  render(order);

  if (isFinal(order)) {
    connectionBox.textContent = "Commande terminée : aucun flux à ouvrir.";
    return;
  }

  const source = new EventSource(`/api/orders/${orderId}/stream`);

  source.onopen = () => {
    connectionBox.textContent = "Connecté au suivi en direct.";
  };

  source.onerror = () => {
    connectionBox.textContent =
      "Connexion interrompue. Reconnexion automatique dans 5 secondes...";
  };

  for (const name of [
    "order-snapshot",
    "order-created",
    "order-updated",
    "order-cancelled"
  ]) {
    source.addEventListener(name, (event) => {
      const updated = JSON.parse(event.data);

      render(updated);
      addHistory(name, updated);

      if (isFinal(updated)) {
        source.close();

        connectionBox.textContent =
          "Commande terminée : connexion SSE fermée.";
      }
    });
  }

  window.addEventListener("pagehide", () => source.close());
}

void start().catch((error) => {
  statusBox.textContent = "Erreur";
  connectionBox.textContent = error.message;
});