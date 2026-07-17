import { z } from "zod";

export const routegoSchemaVersionSchema = z.literal(1);

export const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "Invalid identifier format");

export const nonEmptyTextSchema = z.string().trim().min(1).max(32_000);

export const timestampSchema = z.string().datetime({ offset: true });

export const filePathSchema = z
  .string()
  .min(1)
  .max(32_767)
  .refine((value) => !value.includes("\0"), "Paths cannot contain NUL characters");

export const safeDetailsSchema = z.record(z.string(), z.unknown());

export type SafeDetails = z.infer<typeof safeDetailsSchema>;
