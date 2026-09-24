// src/tailoring/validate.ts
// Hallucination guard for the only free text the LLM writes (summary + cover note):
// every technology and every number must already exist in master-cv.json.
import { hasTerm, normalizeText } from "../ingest/text.js";
import type { MasterCv } from "../schemas/masterCv.js";

// Technologies a model might "helpfully" add. Anything here that the CV doesn't evidence is rejected.
const TECH_LEXICON = [
  "java", "spring boot", "kotlin", "scala", "c#", ".net", "asp.net", "dotnet", "c++", "golang", "rust",
  "ruby", "ruby on rails", "django", "flask", "symfony", "codeigniter", "yii", "angular", "angularjs", "svelte", "next.js",
  "nuxt", "redux", "graphql", "grpc", "kafka", "rabbitmq", "redis", "elasticsearch", "mongodb", "cassandra",
  "dynamodb", "oracle", "sql server", "mssql", "mariadb", "aws", "azure", "gcp", "google cloud", "kubernetes", "k8s",
  "terraform", "ansible", "jenkins", "gitlab ci", "circleci", "helm", "openshift", "microservices", "serverless",
  "lambda", "flutter", "react native", "android", "ios", "tailwind", "jquery", "wordpress", "magento",
  "shopify", "webpack", "vite", "jest", "vitest", "cypress", "playwright", "selenium", "pytest", "tensorflow",
  "pytorch", "langchain", "llamaindex", "rag", "pinecone", "apache spark", "hadoop", "airflow", "power bi", "tableau",
  "sap", "salesforce", "figma", "nestjs", "nest.js", "prisma", "sequelize", "typeorm", "mongoose", "socket.io",
  "websockets", "php", "laravel", "vue", "react", "node.js", "typescript", "python", "fastapi", "docker",
  "postgresql", "mysql", "sqlite", "stripe", "express", "github actions", "phpunit", "linux",
];

const LEARNING_RE = /\b(training|learning|course|program|programme|studying|currently completing|curs|invat|studiez)\b/;
const NUMBER_RE = /\d+(?:[.,]\d+)?/g;
const PLACEHOLDER_RE = /\[[^\]]*\]|\{[^}]*\}|<[^>]*>|lorem ipsum|\bxx+\b/i;

export interface TextRules {
  maxChars: number;
  maxSentences: number;
}

export interface EvidenceIndex {
  corpus: string; // normalized text of everything the candidate can claim
  numbers: Set<string>;
  trainingTerms: string[];
}

export function buildEvidenceIndex(cv: MasterCv): EvidenceIndex {
  const training = cv.skills.filter((s) => s.status === "training").map((s) => s.name);
  const trainingNorm = training.map(normalizeText);
  const facts = [...cv.experience.flatMap((e) => e.facts), ...cv.projects.flatMap((p) => p.facts)];

  // Summary seeds are excluded on purpose: the devops seed names course topics (Kubernetes, AWS...)
  const parts = [
    cv.basics.headline,
    ...cv.skills.filter((s) => s.status === "used").map((s) => s.name),
    ...cv.projects.flatMap((p) => [p.name, ...p.stack]),
    ...cv.experience.flatMap((e) => [e.title, e.company, e.subtitle ?? ""]),
    ...facts.flatMap((f) => [f.text, ...f.skills, f.metric ?? ""]),
    ...cv.certifications.map((c) => c.name),
    ...cv.languages.map((l) => l.name),
  ];
  const corpus = normalizeText(parts.join(" \n "));

  // Numbers the candidate may quote: from facts, seeds (e.g. "4+ years") and certifications
  const years = [...cv.experience, ...cv.education].flatMap((e) => [e.start.slice(0, 4), e.end?.slice(0, 4) ?? ""]);
  const numberSources = [...parts, ...years, ...Object.values(cv.summarySeeds), ...cv.education.map((e) => e.program)].join(" ");
  const numbers = new Set(numberSources.match(NUMBER_RE) ?? []);

  return { corpus, numbers, trainingTerms: [...trainingNorm, "k8s"] };
}

const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export interface PostingContext {
  company: string; // may be named (e.g. "Oracle") without counting as a skill claim
  title: string; // numbers in it may be quoted (e.g. "Team 42"); its technologies are NOT auto-allowed
}

/** Returns human-readable problems; empty array = text is safe to print. */
export function validateClaims(label: string, text: string, index: EvidenceIndex, rules: TextRules, posting: PostingContext): string[] {
  const problems: string[] = [];
  const normalized = normalizeText(text);
  const company = normalizeText(posting.company);
  const postingNumbers = new Set(`${posting.company} ${posting.title}`.match(NUMBER_RE) ?? []);

  if (text.length > rules.maxChars) problems.push(`${label}: ${text.length} chars (max ${rules.maxChars})`);
  const sentences = sentencesOf(text);
  if (sentences.length > rules.maxSentences) problems.push(`${label}: ${sentences.length} sentences (max ${rules.maxSentences})`);
  if (PLACEHOLDER_RE.test(text)) problems.push(`${label}: contains a placeholder or markup`);

  for (const term of TECH_LEXICON) {
    const norm = normalizeText(term);
    if (index.trainingTerms.includes(norm)) continue; // handled below with sentence context
    if (hasTerm(normalized, norm) && !hasTerm(index.corpus, norm) && !hasTerm(company, norm)) {
      problems.push(`${label}: mentions "${term}", which the CV does not evidence`);
    }
  }

  for (const sentence of sentences) {
    const s = normalizeText(sentence);
    for (const term of index.trainingTerms) {
      if (hasTerm(s, term) && !LEARNING_RE.test(s)) {
        problems.push(`${label}: presents "${term}" as experience; it is training-only (mention it only as ongoing training)`);
      }
    }
  }

  for (const n of text.match(NUMBER_RE) ?? []) {
    if (!index.numbers.has(n) && !postingNumbers.has(n)) problems.push(`${label}: number "${n}" does not appear in the CV`);
  }

  return [...new Set(problems)];
}
