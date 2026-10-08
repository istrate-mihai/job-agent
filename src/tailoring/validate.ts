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
  // "PHP 8.2" also evidences "PHP 8"
  const numbers = new Set((numberSources.match(NUMBER_RE) ?? []).flatMap((n) => [n, n.split(/[.,]/)[0] ?? n]));

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
  description?: string; // numbers in it may be quoted only inside an honest gap sentence ("shorter than the 6-9 years you list")
}

// Honest gap statements ("I have not used Nest.js in production yet") name a technology without claiming it
const GAP_RE = /\b(not|never|no|yet to|haven't|have not|hasn't|lack|gap|gaps|without|shorter than|nu am|inca nu|nu detin|lipsa)\b/;

export function validateClaims(label: string, text: string, index: EvidenceIndex, rules: TextRules, posting: PostingContext): string[] {
  const problems: string[] = [];
  const company = normalizeText(posting.company);
  const postingNumbers = new Set(`${posting.company} ${posting.title}`.match(NUMBER_RE) ?? []);

  if (text.length > rules.maxChars) problems.push(`${label}: ${text.length} chars (max ${rules.maxChars})`);
  const sentences = sentencesOf(text);
  if (sentences.length > rules.maxSentences) problems.push(`${label}: ${sentences.length} sentences (max ${rules.maxSentences})`);
  if (PLACEHOLDER_RE.test(text)) problems.push(`${label}: contains a placeholder or markup`);

  const descriptionNumbers = new Set(posting.description?.match(NUMBER_RE) ?? []);
  for (const sentence of sentences) {
    const s = normalizeText(sentence);
    const isGap = GAP_RE.test(s);
    if (!isGap) {
      for (const term of TECH_LEXICON) {
        const norm = normalizeText(term);
        if (index.trainingTerms.includes(norm)) continue; // handled below with learning-context rule
        if (hasTerm(s, norm) && !hasTerm(index.corpus, norm) && !hasTerm(company, norm)) {
          problems.push(`${label}: mentions "${term}", which the CV does not evidence`);
        }
      }
      for (const term of index.trainingTerms) {
        if (hasTerm(s, term) && !LEARNING_RE.test(s)) {
          problems.push(`${label}: presents "${term}" as experience; it is training-only (mention it only as ongoing training)`);
        }
      }
    }
    for (const n of sentence.match(NUMBER_RE) ?? []) {
      const allowed = index.numbers.has(n) || postingNumbers.has(n) || (isGap && descriptionNumbers.has(n));
      if (!allowed) problems.push(`${label}: number "${n}" does not appear in the CV`);
    }
  }

  return [...new Set(problems)];
}

// Recruiters discount self-praise; the CV's evidence should carry the claim
const INFLATION_RE = /\b(expert|guru|ninja|rockstar|world[- ]class|seasoned|extensive|deep expertise|mastery|highly skilled|passionate|exceptional|outstanding)\b/i;
const FIRST_PERSON_RE = /\b(i|i'm|i've|my|me)\b/i;
const MAX_SUMMARY_WORDS = 75;
const COPY_WINDOW = 7; // words copied verbatim from the posting = keyword stuffing

const wordsOf = (text: string): string[] =>
  normalizeText(text)
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, "")) // sentence dots, not "node.js"
    .filter(Boolean);

/** Style checks the claims validator can't see: length, voice, self-praise, copying the posting or the seed. */
export function validateSummaryStyle(summary: string, seeds: readonly string[], postingDescription: string): string[] {
  const problems: string[] = [];
  const words = wordsOf(summary);
  if (words.length > MAX_SUMMARY_WORDS) problems.push(`summary: ${words.length} words (max ${MAX_SUMMARY_WORDS})`);
  if (FIRST_PERSON_RE.test(summary)) problems.push("summary: uses first person; CV summaries are written without \"I\"/\"my\"");
  const inflated = INFLATION_RE.exec(summary)?.[0];
  if (inflated) problems.push(`summary: self-praise ("${inflated}"); let the evidence speak`);

  const posting = ` ${wordsOf(postingDescription).join(" ")} `;
  for (let i = 0; i + COPY_WINDOW <= words.length; i += 1) {
    const window = words.slice(i, i + COPY_WINDOW).join(" ");
    if (posting.includes(` ${window} `)) {
      problems.push(`summary: copies the posting verbatim ("${window}…"); rephrase in the candidate's terms`);
      break;
    }
  }
  const normalizedSummary = wordsOf(summary).join(" ");
  if (seeds.some((seed) => normalizedSummary.includes(wordsOf(seed).join(" ")))) {
    problems.push("summary: repeats a summary seed unchanged; rewrite it for this posting");
  }
  return problems;
}

// Cover letters: written by the candidate, about the candidate, selling — never auditing themselves.
// Third person ("the candidate designed…") reads as machine output; a recruiter stops at the first sentence.
const THIRD_PERSON_RE = /\b(the candidate|the applicant|this candidate|the developer has|candidatul|candidata)\b/i;
// Volunteering unmet requirements in writing hands the reviewer a reason to reject; gaps belong in diff.md for interview prep
const GAP_CONFESSION_RE =
  /\b(not present in (the|my) (cv|resume)|(which|that) i (do not|don't|lack)|i (do not|don't) (yet )?(have|meet|hold|possess)|i (lack|am missing)|although i (do not|don't|lack|have not|haven't)|while i (do not|don't|lack|have not|haven't)|(does|do) not (meet|match) (the|your|all)|falls? short|not (yet )?(have|hold) (a|the|any) (degree|bachelor)|nu (am|detin|indeplinesc))\b/i;
const CLICHE_RE = /\b(i am (excited|thrilled|passionate|proud)|perfect (match|fit)|dream (job|role)|hit the ground running|team player|go-getter|think outside the box|synergy)\b/i;
const FIRST_PERSON_LETTER_RE = /\b(i|i'm|i've|my|me|eu|am|mea|meu)\b/i;

/** Style checks for the cover letter: voice, no self-sabotage, no clichés. Returns problems prefixed "cover letter". */
export function validateLetterStyle(paragraphs: readonly string[]): string[] {
  const problems: string[] = [];
  paragraphs.forEach((p, i) => {
    const label = `cover letter ¶${i + 1}`;
    const third = THIRD_PERSON_RE.exec(p)?.[0];
    if (third) problems.push(`${label}: written in third person ("${third}"); write as the candidate, in first person`);
    const gap = GAP_CONFESSION_RE.exec(p)?.[0];
    if (gap) problems.push(`${label}: admits an unmet requirement ("${gap}"); never mention gaps in the letter, lead with what is evidenced`);
    const cliche = CLICHE_RE.exec(p)?.[0];
    if (cliche) problems.push(`${label}: cliché ("${cliche}"); be specific instead`);
  });
  if (paragraphs.length > 0 && !paragraphs.some((p) => FIRST_PERSON_LETTER_RE.test(p))) {
    problems.push("cover letter: never uses first person; the letter must sound like the candidate wrote it");
  }
  return problems;
}
