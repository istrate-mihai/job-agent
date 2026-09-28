// tests/fileNames.test.ts
import { describe, expect, it } from "vitest";
import { applicationFileBase, cleanJobTitle, fileSafe, namePrefix } from "../src/cv/fileNames.js";
import { loadFixtureCv } from "./helpers.js";

describe("cleanJobTitle", () => {
  it.each([
    ["Software Engineer (Full Stack) - Flutter Studios, Hybrid & Remote", "Flutter Studios", "Software Engineer (Full Stack)"],
    ["Full Stack Developer (m/f/d) Webshop Team, Bucharest (Romania)", "Tchibo", "Full Stack Developer Webshop Team"],
    ["Software Engineer (f/m/d)", "Awin", "Software Engineer"],
    ["Senior Software Engineer, Product Engineering - EU", "Ashby", "Senior Software Engineer, Product Engineering"],
    ["Full Stack Web Development Engineer", "Magna", "Full Stack Web Development Engineer"],
  ])("%s → %s", (title, company, expected) => {
    expect(cleanJobTitle(title, company)).toBe(expected);
  });
});

describe("file naming", () => {
  it("puts the surname first and keeps names filesystem-safe", () => {
    expect(namePrefix(loadFixtureCv(), null)).toBe("Popescu_Alex_Ion");
    expect(namePrefix(loadFixtureCv(), "Custom Prefix")).toBe("Custom_Prefix");
    expect(fileSafe("Brașov & Timișoara (Hybrid)")).toBe("Brasov_Timisoara_Hybrid");
  });

  it("builds <prefix>_<title>_<company>", () => {
    expect(applicationFileBase("Popescu_Alex_Ion", "Senior AI Full Stack Developer (Python & React)", "Accenture Romania")).toBe(
      "Popescu_Alex_Ion_Senior_AI_Full_Stack_Developer_Python_React_Accenture_Romania",
    );
  });
});
