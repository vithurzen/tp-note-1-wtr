const userSelect = document.querySelector("#userId");
const productSelect = document.querySelector("#productId");
const ordersBody = document.querySelector("#orders");
const stocksList = document.querySelector("#stocks");
const messageBox = document.querySelector("#message");

const statusLabels = {
  preparing: "En préparation",
  shipped: "Expédiée",
  delivered: "Livrée",
  cancelled: "Annulée"
};

async function api(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Erreur HTTP ${response.status}`);
  }

  return data;
}

function tableCell(row, text) {
  const td = document.createElement("td");
  td.textContent = String(text);
  row.append(td);
  return td;
}

function fillSelect(select, items, labelOf) {
  const previous = select.value;
  select.replaceChildren();

  for (const item of items) {
    const option = document.createElement("option");
    option.value = String(item.id);
    option.textContent = labelOf(item);
    select.append(option);
  }

  if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
}

function actionButton(parent, label, action) {
  const button = document.createElement("button");
  button.textContent = label;

  button.addEventListener("click", async () => {
    try {
      await action();
      messageBox.textContent = `${label} : opération effectuée.`;
      await refresh();
    } catch (error) {
      messageBox.textContent = error.message;
    }
  });

  parent.append(button);
}

async function refresh() {
  const [users, products, orders] = await Promise.all([
    api("/api/users"),
    api("/api/products"),
    api("/api/orders")
  ]);

  fillSelect(userSelect, users, (user) => user.name);

  fillSelect(
    productSelect,
    products,
    (product) => `${product.name} (stock : ${product.stock})`
  );

  stocksList.replaceChildren();

  for (const product of products) {
    const li = document.createElement("li");
    li.textContent = `${product.name} : ${product.stock} en stock`;
    stocksList.append(li);
  }

  ordersBody.replaceChildren();

  for (const order of orders) {
    const row = document.createElement("tr");

    tableCell(row, order.id);

    tableCell(
      row,
      users.find((user) => user.id === order.userId)?.name || order.userId
    );

    tableCell(
      row,
      products.find((product) => product.id === order.productId)?.name || order.productId
    );

    tableCell(row, order.quantity);
    tableCell(row, statusLabels[order.status] || order.status);

    const actions = tableCell(row, "");

    const link = document.createElement("a");
    link.href = `/suivi.html?id=${order.id}`;
    link.textContent = "Suivre";
    actions.append(link);

    if (order.status === "preparing") {
      actionButton(actions, "Expédier", () =>
        api(`/api/orders/${order.id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: "shipped" })
        })
      );

      actionButton(actions, "Annuler", () =>
        api(`/api/orders/${order.id}`, {
          method: "DELETE"
        })
      );
    }

    if (order.status === "shipped") {
      actionButton(actions, "Livrer maintenant", () =>
        api(`/api/orders/${order.id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: "delivered" })
        })
      );
    }

    ordersBody.append(row);
  }
}

document.querySelector("#order-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const order = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        userId: Number(userSelect.value),
        productId: Number(productSelect.value),
        quantity: Number(document.querySelector("#quantity").value)
      })
    });

    messageBox.textContent = `Commande n°${order.id} créée !`;

    await refresh();
  } catch (error) {
    messageBox.textContent = error.message;
  }
});

const source = new EventSource("/api/events");

for (const name of [
  "order-created",
  "order-updated",
  "order-cancelled",
  "stock-updated"
]) {
  source.addEventListener(name, () => {
    void refresh().catch((error) => {
      messageBox.textContent = error.message;
    });
  });
}

window.addEventListener("pagehide", () => source.close());

void refresh().catch((error) => {
  messageBox.textContent = error.message;
});