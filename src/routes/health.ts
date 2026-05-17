import { Hono } from "hono";
import type { Bindings } from "../index";

export const health = new Hono<{ Bindings: Bindings }>();

health.get("/", (c) =>
	c.json({
		status: "ok",
		service: "garrul",
		time: new Date().toISOString(),
	}),
);
