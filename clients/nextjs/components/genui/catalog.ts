/**
 * Generative UI catalog — component definitions for json-render.
 *
 * Agents write a json-render spec (root + elements map) and include it in a
 * `ui` message part payload.  The spec is constrained to the components listed
 * here; any unknown element type falls back to a safe "unknown component" card.
 *
 * Component vocabulary is inspired by shadcn/ui but rendered with plain
 * Tailwind classes so there are no Radix UI peer-dependency conflicts.
 *
 * Usage from an agent:
 * ```json
 * {
 *   "type": "ui",
 *   "payload": {
 *     "catalog": "shadcn",
 *     "spec": {
 *       "root": "card-1",
 *       "elements": {
 *         "card-1": { "type": "Card", "props": { "title": "Sprint Stats" }, "children": ["metric-1"] },
 *         "metric-1": { "type": "Metric", "props": { "label": "PRs merged", "value": "17" }, "children": [] }
 *       }
 *     }
 *   }
 * }
 * ```
 */

import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

// ── component prop schemas ────────────────────────────────────────────────────

const gapSchema = z.union([z.number().int().min(0).max(16), z.string()]).optional();

const variantSchema = z.enum(["default", "success", "warning", "error", "info"]).optional();

const buttonVariantSchema = z.enum(["default", "outline", "ghost", "destructive"]).optional();

const headingLevelSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4)
]).optional();

// ── catalog ───────────────────────────────────────────────────────────────────

export const genuiCatalog = defineCatalog(schema, {
  components: {
    // Layout
    Stack: {
      props: z.object({
        direction: z.enum(["vertical", "horizontal"]).optional(),
        gap: gapSchema,
        align: z.enum(["start", "center", "end", "stretch"]).optional(),
        wrap: z.boolean().optional(),
      }),
      description: "A flexbox stack. direction defaults to vertical.",
    },
    Card: {
      props: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        footer: z.string().optional(),
      }),
      description: "A card container with optional title, description, and footer.",
    },
    Separator: {
      props: z.object({
        orientation: z.enum(["horizontal", "vertical"]).optional(),
        label: z.string().optional(),
      }),
      description: "A visual separator line.",
    },

    // Typography
    Heading: {
      props: z.object({
        level: headingLevelSchema,
        text: z.string(),
      }),
      description: "A heading (h1–h4) with a text string.",
    },
    Text: {
      props: z.object({
        text: z.string(),
        muted: z.boolean().optional(),
        bold: z.boolean().optional(),
        size: z.enum(["xs", "sm", "base", "lg"]).optional(),
      }),
      description: "A paragraph or inline text.",
    },

    // Data display
    Badge: {
      props: z.object({
        text: z.string(),
        variant: variantSchema,
      }),
      description: "A small badge for status, tags, or labels.",
    },
    Alert: {
      props: z.object({
        title: z.string().optional(),
        message: z.string(),
        variant: variantSchema,
      }),
      description: "An alert box. variant controls the colour theme.",
    },
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        description: z.string().optional(),
        trend: z.enum(["up", "down", "flat"]).optional(),
      }),
      description: "Display a metric with a label and value.",
    },
    Progress: {
      props: z.object({
        value: z.number().min(0).max(100),
        label: z.string().optional(),
        showPercent: z.boolean().optional(),
      }),
      description: "A progress bar, value 0-100.",
    },

    // Tables
    Table: {
      props: z.object({
        caption: z.string().optional(),
      }),
      description: "A table container. Use TableRow and TableCell as children.",
    },
    TableRow: {
      props: z.object({}),
      description: "A table row.",
    },
    TableCell: {
      props: z.object({
        text: z.string().optional(),
        header: z.boolean().optional(),
        align: z.enum(["left", "center", "right"]).optional(),
      }),
      description: "A table cell. Set header=true for <th> styling.",
    },

    // Actions
    Button: {
      props: z.object({
        label: z.string(),
        variant: buttonVariantSchema,
        href: z.string().optional(),
        disabled: z.boolean().optional(),
      }),
      description: "A button. If href is set it renders as a link.",
    },

    // Forms (display-only in message context)
    Input: {
      props: z.object({
        label: z.string().optional(),
        placeholder: z.string().optional(),
        value: z.string().optional(),
        type: z.enum(["text", "number", "email", "url"]).optional(),
        readOnly: z.boolean().optional(),
      }),
      description: "A text input (display mode inside messages).",
    },
    Checkbox: {
      props: z.object({
        label: z.string(),
        checked: z.boolean().optional(),
        readOnly: z.boolean().optional(),
      }),
      description: "A checkbox (display mode inside messages).",
    },

    // Lists
    List: {
      props: z.object({
        ordered: z.boolean().optional(),
      }),
      description: "An ordered or unordered list.",
    },
    ListItem: {
      props: z.object({
        text: z.string(),
      }),
      description: "A list item.",
    },

    // Code
    Code: {
      props: z.object({
        content: z.string(),
        language: z.string().optional(),
      }),
      description: "A code block with optional syntax hint.",
    },
  },
  actions: {
    navigate: {
      description: "Navigate to a URL (href prop on Button).",
    },
    copy: {
      description: "Copy a value to the clipboard.",
    },
  },
});

export type GenuiCatalog = typeof genuiCatalog;
