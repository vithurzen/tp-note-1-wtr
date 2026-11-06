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