// tests/rejections.test.ts
import { describe, expect, it } from "vitest";
import { classifyRejection, companyKeys, parseSender, type ApplicationForMatching } from "../src/reporting/rejections.js";

const applied = new Date("2026-10-01T10:00:00Z");
const later = new Date("2026-10-20T10:00:00Z");
const app = (id: string, company: string, title: string): ApplicationForMatching => ({ id, company, title, appliedAt: applied });

const apps = [
  app("brillio", "Brillio", "Full Stack Engineer"),
  app("tchibo", "Tchibo Romania", "Full Stack Engineer"),
  app("cap-py", "Capgemini", "Python Backend Developer"),
  app("cap-de", "Capgemini", "Junior Data Engineer"),
  app("lseg", "LSEG (London Stock Exchange Group)", "Frontend Engineer"),
];

const email = (from: string, subject: string, text: string, receivedAt = later) => ({ id: "m1", from, subject, text, receivedAt });

describe("companyKeys", () => {
  it("drops legal noise and keeps name variants", () => {
    expect(companyKeys("Tchibo Romania SRL")).toEqual(["tchibo"]);
    expect(companyKeys("LSEG (London Stock Exchange Group)")).toEqual(["lseg", "london stock exchange"]);
    expect(companyKeys("Poșta Română")).toEqual(["posta romana"]);
  });
});

describe("parseSender", () => {
  it("extracts the registrable label", () => {
    expect(parseSender("Careers <noreply@jobs.brillio.com>").label).toBe("brillio");
    expect(parseSender("hr@posta-romana.ro").label).toBe("postaromana");
    expect(parseSender("x@mail.example.co.uk").label).toBe("example");
  });
});

describe("classifyRejection", () => {
  it("auto-marks a clear rejection from the company's own domain", () => {
    const [m, ...rest] = classifyRejection(
      email("Brillio Talent <careers@brillio.com>", "Your application", "Thank you for applying. We have decided to move forward with other candidates whose profile is closer."),
      apps,
    );
    expect(rest).toHaveLength(0);
    expect(m).toMatchObject({ postingId: "brillio", confidence: "high" });
    expect(m?.snippet).toContain("other candidates");
  });

  it("auto-marks a LinkedIn update that names the company in the subject", () => {
    const [m] = classifyRejection(
      email("LinkedIn <jobs-noreply@linkedin.com>", "Your application to Full Stack Engineer at Tchibo", "Unfortunately, Tchibo decided not to move forward with your application."),
      apps,
    );
    expect(m).toMatchObject({ postingId: "tchibo", confidence: "high" });
  });

  it("understands Romanian rejections", () => {
    const [m] = classifyRejection(email("Tchibo <hr@tchibo.ro>", "Candidatura ta", "Din păcate, am decis să continuăm cu alți candidați pentru acest rol."), apps);
    expect(m).toMatchObject({ postingId: "tchibo", confidence: "high" });
  });

  it("asks when only a soft phrase is present", () => {
    const [m] = classifyRejection(email("careers@brillio.com", "Application update", "Unfortunately the assessment link expired, we'll send a new one."), apps);
    expect(m?.confidence).toBe("low");
  });

  it("asks when the email also moves the process forward", () => {
    const [m] = classifyRejection(
      email("careers@brillio.com", "Update", "We are not moving forward with the Full Stack role, but we'd like to schedule a call about another opening."),
      apps,
    );
    expect(m?.confidence).toBe("low");
  });

  it("asks per role when several applications at the company fit", () => {
    const matches = classifyRejection(email("talent@capgemini.com", "Your application", "We regret to inform you that you were not selected."), apps);
    expect(matches.map((m) => [m.postingId, m.confidence])).toEqual([
      ["cap-py", "low"],
      ["cap-de", "low"],
    ]);
  });

  it("picks the right role when the email names it", () => {
    const [m, ...rest] = classifyRejection(email("talent@capgemini.com", "Junior Data Engineer", "We regret to inform you that you were not selected."), apps);
    expect(rest).toHaveLength(0);
    expect(m).toMatchObject({ postingId: "cap-de", confidence: "high" });
  });

  it("ignores job alerts and emails about other companies", () => {
    expect(classifyRejection(email("jobalerts-noreply@linkedin.com", "New jobs for you", "Brillio is hiring. Unfortunately…"), apps)).toEqual([]);
    expect(classifyRejection(email("hr@other.com", "Your application", "We regret to inform you that you were not selected."), apps)).toEqual([]);
  });

  it("ignores emails received before the application", () => {
    expect(classifyRejection(email("careers@brillio.com", "x", "We regret to inform you that you were not selected.", new Date("2026-09-01")), apps)).toEqual([]);
  });

  it("marks a platform sender with the company only in the body as low", () => {
    const [m] = classifyRejection(email("no-reply@greenhouse.io", "Thank you for applying", "Hi Mihai, at Brillio we regret to inform you that you were not selected."), apps);
    expect(m).toMatchObject({ postingId: "brillio", confidence: "low" });
  });
});
