import { z } from "zod";

export const createOrderSchema = z.object({
  customer_id: z.string().uuid(),
  washer_id: z.string().uuid(),
  total_amount: z.number().positive(),
});
export const releaseOrderSchema = z.object({
  orderId: z.string().uuid(), // ensures a valid UUID
});
