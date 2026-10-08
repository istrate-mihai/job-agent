// src/schemas/masterCv.ts
import { z } from "zod";

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");
const Slug = z.string().regex(/^[a-z0-9-]+$/, "kebab-case ids only");

export const RoleTag = z.enum(["fullstack", "backend", "frontend", "ai", "devops", "industrial"]);

export const FactSchema = z.object({
  id: Slug, // referenced by tailored bullets for provenance
  text: z.string().min(20).max(300),
  skills: z.array(z.string().min(1)).min(1),
  metric: z.string().optional(), // e.g. "30% faster analytics queries"
  evidenceUrl: z.url().optional(),
  roles: z.array(RoleTag).min(1),
});

export const ExperienceSchema = z.object({
  id: Slug,
  type: z.enum(["software", "independent", "industrial"]), // lets the renderer split IT vs industrial sections
  company: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  location: z.string(),
  start: YearMonth,
  end: YearMonth.nullable(), // null = current
  facts: z.array(FactSchema).min(1),
});

export const ProjectSchema = z.object({
  id: Slug,
  name: z.string(),
  repoUrl: z.url().optional(),
  liveUrl: z.url().optional(),
  stack: z.array(z.string()).min(1),
  roles: z.array(RoleTag).min(1),
  facts: z.array(FactSchema).min(1),
});

export const SkillSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["languages", "backend", "frontend", "databases", "devops", "integrations", "testing", "industrial", "practices"]),
  status: z.enum(["used", "training"]), // "training" skills may be listed, never claimed inside a fact
});

export const MasterCvSchema = z.object({
  basics: z.object({
    fullName: z.string(),
    headline: z.string(),
    email: z.email(),
    phone: z.string(),
    location: z.string(),
    links: z.object({
      github: z.url().optional(),
      linkedin: z.url().optional(),
      portfolio: z.url().optional(),
    }),
    relocation: z.object({
      available: z.boolean(),
      cities: z.array(z.string()),
    }),
  }),
  summarySeeds: z.record(RoleTag, z.string().max(400)), // exhaustive: one seed per role tag
  experience: z.array(ExperienceSchema).min(1),
  projects: z.array(ProjectSchema),
  skills: z.array(SkillSchema).min(1),
  education: z.array(
    z.object({
      institution: z.string(),
      program: z.string(),
      location: z.string().optional(),
      start: YearMonth,
      end: YearMonth.nullable(),
      details: z.string().optional(),
      url: z.url().optional(),
    }),
  ),
  certifications: z.array(
    z.object({
      name: z.string(),
      issuer: z.string(),
      credentialId: z.string().optional(),
      year: z.number().int().optional(),
      url: z.url().optional(),
    }),
  ),
  languages: z.array(z.object({ name: z.string(), cefr: z.enum(["A1", "A2", "B1", "B2", "C1", "C2", "native"]) })),
});

export type MasterCv = z.infer<typeof MasterCvSchema>;
export type Fact = z.infer<typeof FactSchema>;
