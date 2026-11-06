import express, { type Response, type ErrorRequestHandler } from "express";
import cors from "cors";
import { JsonDB, Config } from "node-json-db";

type User = {
  id: number;
  name: string;
  username: string;
  email: string;
};

type Product = {
  id: number;
  name: string;
  stock: number;
};

type Status = "preparing" | "shipped" | "delivered" | "cancelled";

type Order = {
  id: number;
  userId: User["id"];
  productId: Product["id"];
  quantity: number;
  status: Status;
  createdAt: string;
};

type OrderEvent = {
  id: number;
  name: "order-created" | "order-updated" | "order-cancelled";
  orderId: number;
  data: Order;
};

type StockEvent = {
  id: number;
  name: "stock-updated";
  orderId: number;
  data: Product;
};

type StoredEvent = OrderEvent | StockEvent;

type DatabaseState = {
  users: User[];
  products: Product[];
  orders: Order[];
  events: StoredEvent[];
  lastEventId: number;
  nextOrderId: number;
  shippedAt: Record<string, string>;
};

type Subscriber = {
  res: Response;
  orderId: number | null;
  heartbeat: NodeJS.Timeout;
};

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const db = new JsonDB(new Config("data/db", true, true, "/"));
let state: DatabaseState;
const subscribers = new Set<Subscriber>();
const deliveryTimers = new Map<number, NodeJS.Timeout>();
let writeQueue: Promise<void> = Promise.resolve();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readId(value: string): number {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) {
    throw new HttpError(400, "Identifiant invalide");
  }
  return id;
}

function orderIsFinal(order: Order): boolean {
  return order.status === "delivered" || order.status === "cancelled";
}

function addOrderEvent(
  draft: DatabaseState,
  name: OrderEvent["name"],
  order: Order
): OrderEvent {
  const event: OrderEvent = {
    id: ++draft.lastEventId,
    name,
    orderId: order.id,
    data: { ...order }
  };
  draft.events.push(event);
  return event;
}

function addStockEvent(
  draft: DatabaseState,
  orderId: number,
  product: Product
): StockEvent {
  const event: StockEvent = {
    id: ++draft.lastEventId,
    name: "stock-updated",
    orderId,
    data: { ...product }
  };
  draft.events.push(event);
  return event;
}

function unsubscribe(subscriber: Subscriber): void {
  clearInterval(subscriber.heartbeat);
  subscribers.delete(subscriber);
}

function writeEvent(subscriber: Subscriber, event: StoredEvent): void {
  if (
    subscriber.orderId !== null &&
    (event.name === "stock-updated" || event.orderId !== subscriber.orderId)
  ) {
    return;
  }

  subscriber.res.write(
    `id: ${event.id}\nevent: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`
  );

  if (
    subscriber.orderId !== null &&
    event.name !== "stock-updated" &&
    orderIsFinal(event.data)
  ) {
    unsubscribe(subscriber);
    subscriber.res.end();
  }
}

function broadcast(event: StoredEvent): void {
  for (const subscriber of subscribers) {
    writeEvent(subscriber, event);
  }
}

function transaction<T>(
  mutate: (draft: DatabaseState) => { result: T; events: StoredEvent[] }
): Promise<T> {
  const run = writeQueue.then(async () => {
    const draft = structuredClone(state);
    const { result, events } = mutate(draft);
    await db.push("/state", draft, true);
    state = draft;
    for (const event of events) broadcast(event);
    for (const event of events) {
      if (event.name === "order-updated") {
        if (event.data.status === "shipped") scheduleDelivery(event.data);
        if (event.data.status === "delivered") clearDelivery(event.data.id);
      }
      if (event.name === "order-cancelled") clearDelivery(event.data.id);
    }
    return result;
  });

  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

function clearDelivery(id: number): void {
  const timer = deliveryTimers.get(id);
  if (timer) clearTimeout(timer);
  deliveryTimers.delete(id);
}

function scheduleDelivery(order: Order): void {
  clearDelivery(order.id);
  if (order.status !== "shipped") return;

  const date = state.shippedAt[String(order.id)];
  const shippingTime = Date.parse(date ?? order.createdAt);
  const delay = Math.max(0, shippingTime + 20_000 - Date.now());
  const timer = setTimeout(() => {
    deliveryTimers.delete(order.id);
    void deliverAutomatically(order.id).catch(console.error);
  }, delay);
  deliveryTimers.set(order.id, timer);
}

async function deliverAutomatically(id: number): Promise<void> {
  await transaction((draft) => {
    const order = draft.orders.find((item) => item.id === id);
    if (!order || order.status !== "shipped") {
      return { result: undefined, events: [] };
    }
    order.status = "delivered";
    delete draft.shippedAt[String(id)];
    const event = addOrderEvent(draft, "order-updated", order);
    return { result: undefined, events: [event] };
  });
}

function openSse(res: Response, orderId: number | null, lastId: number | null): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();

  res.write("retry: 5000\n\n");

  const subscriber: Subscriber = {
    res,
    orderId,

    heartbeat: setInterval(() => res.write(": heartbeat\n\n"), 15_000)
  };

  subscribers.add(subscriber);

  res.on("close", () => unsubscribe(subscriber));

  if (lastId !== null) {
    for (const event of state.events) {
      if (event.id > lastId) {
        writeEvent(subscriber, event);
        if (!subscribers.has(subscriber)) return;
      }
    }
  }

  if (orderId !== null) {
    const order = state.orders.find((item) => item.id === orderId);
    if (!order) return;

    if (lastId === null || orderIsFinal(order)) {
      const mostRecent = state.events
        .filter((event) => event.orderId === orderId && event.name !== "stock-updated")
        .at(-1);

      const idLine = mostRecent ? `id: ${mostRecent.id}\n` : "";

      res.write(
        `${idLine}event: order-snapshot\ndata: ${JSON.stringify(order)}\n\n`
      );
    }

    if (orderIsFinal(order)) {
      unsubscribe(subscriber);
      res.end();
    }
  }
}

app.get("/api/users", (_req, res) => res.json(state.users));

app.get("/api/products", (_req, res) => res.json(state.products));

app.get("/api/orders", (_req, res) => res.json(state.orders));

app.get("/api/orders/:id", (req, res) => {
  const order = state.orders.find((item) => item.id === readId(req.params.id));
  if (!order) throw new HttpError(404, "Commande introuvable");
  res.json(order);
});

app.post("/api/orders", async (req, res) => {
  const body: unknown = req.body;

  if (
    !isObject(body) ||
    !isPositiveInteger(body.userId) ||
    !isPositiveInteger(body.productId) ||
    !isPositiveInteger(body.quantity)
  ) {
    throw new HttpError(
      400,
      "userId, productId et quantity doivent être des entiers positifs"
    );
  }

  const { userId, productId, quantity } = body;

  const order = await transaction((draft) => {
    if (!draft.users.some((user) => user.id === userId)) {
      throw new HttpError(404, "Utilisateur introuvable");
    }

    const product = draft.products.find((item) => item.id === productId);

    if (!product) throw new HttpError(404, "Produit introuvable");
    if (product.stock < quantity) throw new HttpError(409, "Stock insuffisant");

    const created: Order = {
      id: draft.nextOrderId++,
      userId,
      productId,
      quantity,
      status: "preparing",
      createdAt: new Date().toISOString()
    };

    draft.orders.push(created);
    product.stock -= quantity;

    const events: StoredEvent[] = [
      addOrderEvent(draft, "order-created", created),
      addStockEvent(draft, created.id, product)
    ];

    return { result: created, events };
  });

  res.status(201).json(order);
});

app.patch("/api/orders/:id/status", async (req, res) => {
  const id = readId(req.params.id);
  const body: unknown = req.body;

  if (!isObject(body) || (body.status !== "shipped" && body.status !== "delivered")) {
    throw new HttpError(400, "Statut attendu : shipped ou delivered");
  }

  const desiredStatus = body.status;

  const updated = await transaction((draft) => {
    const order = draft.orders.find((item) => item.id === id);

    if (!order) throw new HttpError(404, "Commande introuvable");

    const valid =
      (order.status === "preparing" && desiredStatus === "shipped") ||
      (order.status === "shipped" && desiredStatus === "delivered");

    if (!valid) throw new HttpError(409, "Transition de statut interdite");

    order.status = desiredStatus;

    if (desiredStatus === "shipped") {
      draft.shippedAt[String(id)] = new Date().toISOString();
    } else {
      delete draft.shippedAt[String(id)];
    }

    const event = addOrderEvent(draft, "order-updated", order);

    return { result: order, events: [event] };
  });

  res.json(updated);
});

app.delete("/api/orders/:id", async (req, res) => {
  const id = readId(req.params.id);

  const cancelled = await transaction((draft) => {
    const order = draft.orders.find((item) => item.id === id);

    if (!order) throw new HttpError(404, "Commande introuvable");

    if (order.status !== "preparing") {
      throw new HttpError(
        409,
        "Seule une commande en préparation peut être annulée"
      );
    }

    const product = draft.products.find((item) => item.id === order.productId);

    if (!product) {
      throw new HttpError(500, "Produit lié à la commande introuvable");
    }

    order.status = "cancelled";
    product.stock += order.quantity;

    const events: StoredEvent[] = [
      addOrderEvent(draft, "order-cancelled", order),
      addStockEvent(draft, order.id, product)
    ];

    return { result: order, events };
  });

  res.json(cancelled);
});

app.get("/api/events", (req, res) => {
  const raw = req.get("Last-Event-ID");
  const lastId = raw && /^\d+$/.test(raw) ? Number(raw) : null;

  openSse(res, null, lastId);
});

app.get("/api/orders/:id/stream", (req, res) => {
  const id = readId(req.params.id);
  const order = state.orders.find((item) => item.id === id);

  if (!order) throw new HttpError(404, "Commande introuvable");

  const raw = req.get("Last-Event-ID");
  const lastId = raw && /^\d+$/.test(raw) ? Number(raw) : null;

  openSse(res, id, lastId);
});

const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (res.headersSent) return;

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Erreur interne du serveur" });
};

app.use(errorHandler);

async function main(): Promise<void> {
  state = await db.getObject<DatabaseState>("/state");

  for (const order of state.orders) {
    if (order.status === "shipped") scheduleDelivery(order);
  }

  const port = Number(process.env.PORT) || 3000;

  app.listen(port, "0.0.0.0", () => {
    console.log(`Boutique disponible sur http://localhost:${port}`);
  });
}

void main().catch((error: unknown) => {
  console.error("Impossible de démarrer la base JsonDB :", error);
  process.exit(1);
});