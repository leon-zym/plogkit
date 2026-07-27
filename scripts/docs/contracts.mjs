import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ADR_STATUSES = ["已接受", "部分修订", "已取代"];
const SPEC_STATUSES = ["草拟", "已确认", "已实现"];

function read(rootDir, relativePath) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

function readRequired(rootDir, relativePath, errors) {
  if (!existsSync(path.join(rootDir, relativePath))) {
    errors.push(`${relativePath}: required file is missing`);
    return undefined;
  }
  return read(rootDir, relativePath);
}

function listRequiredDirectory(rootDir, relativePath, errors) {
  if (!existsSync(path.join(rootDir, relativePath))) {
    errors.push(`${relativePath}: required directory is missing`);
    return [];
  }
  return readdirSync(path.join(rootDir, relativePath));
}

function isValidDate(value) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match === undefined || match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

function metadataValues(document, field) {
  const pattern = new RegExp(
    `^[ \\t]{0,3}[-+*][ \\t]+${field}：(.+)$`,
    "gm",
  );
  return [...document.matchAll(pattern)].map((match) => match[1].trim());
}

function hasNonEmptySection(document, heading) {
  return levelTwoSections(document).some(
    (section) => section.heading === heading && section.hasVisibleContent,
  );
}

function maskHtmlComments(document) {
  return document.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
    comment.replace(/[^\r\n]/g, " "),
  );
}

function maskMarkdownCode(document) {
  let fence;
  return maskHtmlComments(document)
    .split("\n")
    .map((line) => {
      if (fence !== undefined) {
        const closingFence = line.match(/^ {0,3}(`+|~+)[ \t]*$/)?.[1];
        if (
          closingFence !== undefined &&
          closingFence[0] === fence.marker &&
          closingFence.length >= fence.length
        ) {
          fence = undefined;
        }
        return " ".repeat(line.length);
      }

      const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      if (openingFence !== undefined) {
        fence = { marker: openingFence[0], length: openingFence.length };
        return " ".repeat(line.length);
      }

      return line.replace(/(`+)(.*?)\1/g, (code) => " ".repeat(code.length));
    })
    .join("\n");
}

function levelTwoSections(document) {
  const structure = maskMarkdownCode(document);
  const headings = [...structure.matchAll(/^## (.+)$/gm)];
  return headings.map((heading, index) => {
    const bodyStart = heading.index + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? document.length;
    const body = document.slice(bodyStart, bodyEnd).trim();
    return {
      heading: heading[1].trim(),
      body,
      hasVisibleContent: maskHtmlComments(body).trim().length > 0,
    };
  });
}

function hasNavigationLink(document, target) {
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[[^\\]\\n]+\\]\\(${escapedTarget}\\)`).test(maskMarkdownCode(document));
}

function adrReferences(value) {
  return [...value.matchAll(/\[(?:ADR )?(\d{4})\]\(([^)]+)\)/g)].map((match) => ({
    id: match[1],
    target: match[2],
  }));
}

function documentTargetMatchesFile(directory, target, file) {
  const pathWithoutFragment = target.split("#", 1)[0];
  return (
    path.posix.resolve(directory, pathWithoutFragment) ===
    path.posix.resolve(directory, file)
  );
}

function adrTargetMatchesFile(target, file) {
  return documentTargetMatchesFile("/docs/adr", target, file);
}

function specTargetMatchesFile(target, file) {
  return documentTargetMatchesFile("/docs/specs", target, file);
}

function adrComesBefore(leftId, left, rightId, right) {
  if (!isValidDate(left.acceptedDate) || !isValidDate(right.acceptedDate)) {
    return false;
  }
  const dateOrder = left.acceptedDate.localeCompare(right.acceptedDate);
  return dateOrder < 0 || (dateOrder === 0 && leftId.localeCompare(rightId) < 0);
}

function indexById(entries, indexPath, errors) {
  const result = new Map();
  for (const entry of entries) {
    if (result.has(entry.id)) {
      errors.push(`${indexPath}: duplicate index entry for ${entry.id}`);
    } else {
      result.set(entry.id, entry);
    }
  }
  return result;
}

function uniqueDocumentFiles(files, idFromFile, directory, errors) {
  const filesById = new Map();
  for (const file of files) {
    const id = idFromFile(file);
    const matchingFiles = filesById.get(id) ?? [];
    matchingFiles.push(file);
    filesById.set(id, matchingFiles);
  }

  const uniqueFiles = [];
  for (const [id, matchingFiles] of filesById) {
    if (matchingFiles.length === 1) {
      uniqueFiles.push(matchingFiles[0]);
    } else {
      errors.push(`${directory}: duplicate document ID ${id} (${matchingFiles.join(", ")})`);
    }
  }
  return uniqueFiles;
}

function haveSameValues(left, right) {
  const leftValues = new Set(left);
  const rightValues = new Set(right);
  return (
    leftValues.size === rightValues.size &&
    [...leftValues].every((value) => rightValues.has(value))
  );
}

function formalDocumentFiles(entries, pattern, directory, format, errors) {
  const markdownFiles = entries
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort();
  for (const file of markdownFiles) {
    if (!pattern.test(file)) {
      errors.push(`${directory}/${file}: filename must match ${format}`);
    }
  }
  return markdownFiles.filter((file) => pattern.test(file));
}

function validateAdrIndex(rootDir) {
  const errors = [];
  const allAdrFiles = formalDocumentFiles(
    listRequiredDirectory(rootDir, "docs/adr", errors),
    /^\d{4}-.+\.md$/,
    "docs/adr",
    "NNNN-slug.md",
    errors,
  );
  const adrFiles = uniqueDocumentFiles(allAdrFiles, (file) => file.slice(0, 4), "docs/adr", errors);
  const index = maskMarkdownCode(readRequired(rootDir, "docs/adr/README.md", errors) ?? "");
  const indexEntries = indexById(
    [
      ...index.matchAll(
        /^\|\s*\[(\d{4})\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|$/gm,
      ),
    ].map((match) => ({
      id: match[1],
      file: match[2],
      title: match[3].trim(),
      status: match[4].trim(),
      successors: adrReferences(match[5]),
    })),
    "docs/adr/README.md",
    errors,
  );
  const documents = new Map(
    adrFiles.map((file) => {
      const document = read(rootDir, `docs/adr/${file}`);
      const structure = maskMarkdownCode(document);
      const preamble = structure.split(/^## /m, 1)[0];
      const header = structure.match(/^# ADR (\d{4})：(.*)$/m);
      const statuses = metadataValues(preamble, "状态");
      const acceptedDates = metadataValues(preamble, "接受日期");
      const successors = metadataValues(preamble, "后继").flatMap((value) =>
        adrReferences(value),
      );
      const predecessors = [
        ...preamble.matchAll(/^[ \t]{0,3}[-+*][ \t]+(修订|取代)：(.+)$/gm),
      ].flatMap(
        (metadata) =>
          adrReferences(metadata[2].trim()).map((reference) => ({
            ...reference,
            kind: metadata[1],
          })),
      );
      return [
        file.slice(0, 4),
        {
          file,
          text: document,
          headerId: header?.[1],
          title: header?.[2].trim(),
          status: statuses[0],
          statusCount: statuses.length,
          acceptedDate: acceptedDates[0],
          acceptedDateCount: acceptedDates.length,
          successors,
          predecessors,
        },
      ];
    }),
  );
  const firstReplacements = new Map();
  for (const [successorId, successor] of documents) {
    if (!isValidDate(successor.acceptedDate)) continue;
    for (const predecessor of successor.predecessors) {
      if (predecessor.kind !== "取代") continue;
      const firstReplacement = firstReplacements.get(predecessor.id);
      if (
        firstReplacement === undefined ||
        adrComesBefore(
          successorId,
          successor,
          firstReplacement.id,
          firstReplacement.document,
        )
      ) {
        firstReplacements.set(predecessor.id, {
          id: successorId,
          document: successor,
        });
      }
    }
  }

  for (const [id, document] of documents) {
    const entry = indexEntries.get(id);
    if (entry === undefined) {
      errors.push(`docs/adr/README.md: missing index entry for ADR ${id} (${document.file})`);
    } else {
      if (!adrTargetMatchesFile(entry.file, document.file)) {
        errors.push(
          `docs/adr/README.md: ADR ${id} link mismatch (index: ${entry.file}, document: ${document.file})`,
        );
      }
      if (entry.status !== document.status) {
        errors.push(
          `docs/adr/README.md: ADR ${id} status mismatch (index: ${entry.status}, document: ${document.status ?? "missing"})`,
        );
      }
      if (entry.title !== document.title) {
        errors.push(
          `docs/adr/README.md: ADR ${id} title mismatch (index: "${entry.title}", document: "${document.title ?? "missing"}")`,
        );
      }
      const indexSuccessorIds = entry.successors.map((successor) => successor.id);
      const documentSuccessorIds = document.successors.map((successor) => successor.id);
      if (!haveSameValues(indexSuccessorIds, documentSuccessorIds)) {
        errors.push(
          `docs/adr/README.md: ADR ${id} successor mismatch (index: ${indexSuccessorIds.join(", ") || "none"}, document: ${documentSuccessorIds.join(", ") || "none"})`,
        );
      }
    }

    if (!ADR_STATUSES.includes(document.status)) {
      errors.push(
        `docs/adr/${document.file}: invalid ADR status "${document.status ?? "missing"}"`,
      );
    }
    if (document.statusCount > 1) {
      errors.push(`docs/adr/${document.file}: duplicate ADR status fields`);
    }
    if (document.headerId !== id) {
      errors.push(
        `docs/adr/${document.file}: filename ADR ${id} does not match header ADR ${document.headerId ?? "missing"}`,
      );
    }
    if (document.title === undefined || document.title.length === 0) {
      errors.push(`docs/adr/${document.file}: ADR title must not be empty`);
    }
    if (!isValidDate(document.acceptedDate)) {
      errors.push(`docs/adr/${document.file}: accepted date must use a valid YYYY-MM-DD value`);
    }
    if (document.acceptedDateCount > 1) {
      errors.push(`docs/adr/${document.file}: duplicate accepted date fields`);
    }
    if (
      (document.status === "部分修订" || document.status === "已取代") &&
      document.successors.length === 0
    ) {
      errors.push(
        `docs/adr/${document.file}: status ${document.status} requires at least one successor ADR`,
      );
    }
    if (document.status === "已接受" && document.successors.length > 0) {
      errors.push(`docs/adr/${document.file}: status 已接受 must not declare successor ADRs`);
    }
    for (const section of ["背景", "决策", "影响与代价"]) {
      if (!hasNonEmptySection(document.text, section)) {
        errors.push(`docs/adr/${document.file}: required section "${section}" is missing or empty`);
      }
    }
    for (const section of levelTwoSections(document.text)) {
      if (
        !["背景", "决策", "影响与代价"].includes(section.heading) &&
        !section.hasVisibleContent
      ) {
        errors.push(
          `docs/adr/${document.file}: optional section "${section.heading}" is empty`,
        );
      }
    }
  }

  for (const [id, entry] of indexEntries) {
    if (!ADR_STATUSES.includes(entry.status)) {
      errors.push(`docs/adr/README.md: ADR ${id} has invalid status "${entry.status}"`);
    }
    if (!documents.has(id)) {
      errors.push(`docs/adr/README.md: ADR ${id} index entry has no document (${entry.file})`);
    }
    for (const successor of entry.successors) {
      const successorDocument = documents.get(successor.id);
      if (
        successorDocument !== undefined &&
        !adrTargetMatchesFile(successor.target, successorDocument.file)
      ) {
        errors.push(
          `docs/adr/README.md: ADR ${id} successor ADR ${successor.id} link mismatch (target: ${successor.target}, document: ${successorDocument.file})`,
        );
      }
    }
  }

  for (const [id, document] of documents) {
    for (const successor of document.successors) {
      if (successor.id === id) {
        errors.push(`docs/adr/${document.file}: successor ADR must not reference itself`);
      }
      const successorDocument = documents.get(successor.id);
      if (
        successorDocument !== undefined &&
        !adrTargetMatchesFile(successor.target, successorDocument.file)
      ) {
        errors.push(
          `docs/adr/${document.file}: successor ADR ${successor.id} link mismatch (target: ${successor.target}, document: ${successorDocument.file})`,
        );
      }
      if (!successorDocument?.predecessors.some((predecessor) => predecessor.id === id)) {
        errors.push(
          `docs/adr/${document.file}: successor ADR ${successor.id} does not declare predecessor ADR ${id}`,
        );
      }
    }
    for (const predecessor of document.predecessors) {
      if (predecessor.id === id) {
        errors.push(`docs/adr/${document.file}: predecessor ADR must not reference itself`);
      }
      const predecessorDocument = documents.get(predecessor.id);
      if (
        predecessorDocument !== undefined &&
        !adrTargetMatchesFile(predecessor.target, predecessorDocument.file)
      ) {
        errors.push(
          `docs/adr/${document.file}: predecessor ADR ${predecessor.id} link mismatch (target: ${predecessor.target}, document: ${predecessorDocument.file})`,
        );
      }
      if (!predecessorDocument?.successors.some((successor) => successor.id === id)) {
        errors.push(
          `docs/adr/${document.file}: predecessor ADR ${predecessor.id} does not declare successor ADR ${id}`,
        );
      }
      const firstReplacement = firstReplacements.get(predecessor.id);
      const isHistoricalRevision =
        predecessor.kind === "修订" &&
        firstReplacement !== undefined &&
        adrComesBefore(id, document, firstReplacement.id, firstReplacement.document);
      if (
        predecessorDocument?.status === "已取代" &&
        predecessor.kind === "修订" &&
        firstReplacement !== undefined &&
        !isHistoricalRevision
      ) {
        errors.push(
          `docs/adr/${document.file}: predecessor ADR ${predecessor.id} uses 修订 after replacement by ADR ${firstReplacement.id}`,
        );
        continue;
      }
      const expectedKind =
        predecessorDocument?.status === "部分修订"
          ? "修订"
          : predecessorDocument?.status === "已取代" && !isHistoricalRevision
            ? "取代"
            : undefined;
      if (
        (expectedKind !== undefined && predecessor.kind !== expectedKind) ||
        (predecessor.kind === "取代" && predecessorDocument?.status !== "已取代")
      ) {
        errors.push(
          `docs/adr/${document.file}: predecessor ADR ${predecessor.id} uses ${predecessor.kind} but status ${predecessorDocument?.status ?? "missing"} requires ${expectedKind ?? "已取代"}`,
        );
      }
    }
  }

  return errors;
}

function validateSpecIndex(rootDir) {
  const errors = [];
  const allSpecFiles = formalDocumentFiles(
    listRequiredDirectory(rootDir, "docs/specs", errors),
    /^F\d{2}-.+\.md$/,
    "docs/specs",
    "FNN-slug.md",
    errors,
  );
  const specFiles = uniqueDocumentFiles(
    allSpecFiles,
    (file) => file.slice(0, 3),
    "docs/specs",
    errors,
  );
  const index = maskMarkdownCode(readRequired(rootDir, "docs/specs/README.md", errors) ?? "");
  const indexEntries = indexById(
    [...index.matchAll(/^\|\s*\[(F\d{2})\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*(.+?)\s*\|$/gm)].map(
      (match) => ({
        id: match[1],
        file: match[2],
        title: match[3].trim(),
        status: match[4].trim(),
      }),
    ),
    "docs/specs/README.md",
    errors,
  );

  for (const file of specFiles) {
    const id = file.slice(0, 3);
    const entry = indexEntries.get(id);
    const document = read(rootDir, `docs/specs/${file}`);
    const structure = maskMarkdownCode(document);
    const header = structure.match(/^# (F\d{2}) (.*)$/m);
    const documentTitle = header?.[2].trim();
    const preamble = structure.split(/^## /m, 1)[0];
    const documentStatuses = metadataValues(preamble, "状态");
    const documentStatus = documentStatuses[0];

    if (entry === undefined) {
      errors.push(`docs/specs/README.md: missing index entry for ${id} (${file})`);
    } else {
      if (!specTargetMatchesFile(entry.file, file)) {
        errors.push(
          `docs/specs/README.md: ${id} link mismatch (index: ${entry.file}, document: ${file})`,
        );
      }
      if (entry.status !== documentStatus) {
        errors.push(
          `docs/specs/README.md: ${id} status mismatch (index: ${entry.status}, document: ${documentStatus ?? "missing"})`,
        );
      }
      if (entry.title !== documentTitle) {
        errors.push(
          `docs/specs/README.md: ${id} title mismatch (index: "${entry.title}", document: "${documentTitle ?? "missing"}")`,
        );
      }
    }

    if (!SPEC_STATUSES.includes(documentStatus)) {
      errors.push(`docs/specs/${file}: invalid spec status "${documentStatus ?? "missing"}"`);
    }
    if (documentStatuses.length > 1) {
      errors.push(`docs/specs/${file}: duplicate overall status fields`);
    }
    if (header?.[1] !== id) {
      errors.push(
        `docs/specs/${file}: filename ${id} does not match header ${header?.[1] ?? "missing"}`,
      );
    }
    if (documentTitle === undefined || documentTitle.length === 0) {
      errors.push(`docs/specs/${file}: spec title must not be empty`);
    }
    const sections = levelTwoSections(document);
    for (const section of ["概述", "需求与场景"]) {
      if (
        !sections.some(
          (candidate) => candidate.heading === section && candidate.hasVisibleContent,
        )
      ) {
        errors.push(`docs/specs/${file}: required section "${section}" is missing or empty`);
      }
    }
    for (const section of ["实施跟踪", "已解决问题", "后续观察", "开放问题"]) {
      if (sections.some((candidate) => candidate.heading === section)) {
        errors.push(`docs/specs/${file}: forbidden section "${section}"`);
      }
    }

    const requirements =
      sections.find((section) => section.heading === "需求与场景")?.body ?? "";
    const scenarios = maskMarkdownCode(requirements).split(/^#### Scenario: /m).slice(1);
    if (scenarios.length === 0) {
      errors.push(`docs/specs/${file}: requires at least one Scenario`);
    }
    for (const scenario of scenarios) {
      const name = scenario.split("\n", 1)[0].trim();
      const body = scenario.split(/^#{2,4} /m)[0];
      for (const step of ["GIVEN", "WHEN", "THEN"]) {
        if (
          !new RegExp(
            `^[ \\t]{0,3}(?:(?:[-+*]|\\d+[.)])[ \\t]+)?${step}(?:\\s|$)`,
            "m",
          ).test(body)
        ) {
          errors.push(`docs/specs/${file}: Scenario "${name}" is missing ${step}`);
        }
      }
      const scenarioStatuses = metadataValues(body, "状态");
      const scenarioStatus = scenarioStatuses[0];
      const issue = metadataValues(body, "Issue")[0];
      const isUnimplementedOverride =
        scenarioStatus !== undefined &&
        SPEC_STATUSES.includes(scenarioStatus) &&
        scenarioStatus !== documentStatus &&
        scenarioStatus !== "已实现";
      if (issue !== undefined && !isUnimplementedOverride) {
        errors.push(
          `docs/specs/${file}: Scenario "${name}" has Issue metadata without an unimplemented status override`,
        );
      }
      if (scenarioStatuses.length > 1) {
        errors.push(
          `docs/specs/${file}: Scenario "${name}" has duplicate status fields`,
        );
      }
      if (scenarioStatus !== undefined && !SPEC_STATUSES.includes(scenarioStatus)) {
        errors.push(
          `docs/specs/${file}: Scenario "${name}" has invalid status "${scenarioStatus}"`,
        );
      } else if (scenarioStatus === documentStatus) {
        errors.push(
          `docs/specs/${file}: Scenario "${name}" repeats inherited status ${documentStatus}`,
        );
      } else if (scenarioStatus === "已实现") {
        errors.push(
          `docs/specs/${file}: Scenario "${name}" has a stale implemented status override`,
        );
      } else if (isUnimplementedOverride) {
        if (issue === undefined || !/(?:#\d+|\/issues\/\d+)/.test(issue)) {
          errors.push(
            `docs/specs/${file}: Scenario "${name}" overrides ${documentStatus} with ${scenarioStatus} but has no Issue`,
          );
        }
      }
    }
  }

  for (const [id, entry] of indexEntries) {
    if (!SPEC_STATUSES.includes(entry.status)) {
      errors.push(`docs/specs/README.md: ${id} has invalid status "${entry.status}"`);
    }
    if (!specFiles.some((file) => file.startsWith(`${id}-`))) {
      errors.push(`docs/specs/README.md: ${id} index entry has no document (${entry.file})`);
    }
  }

  return errors;
}

function validateNavigation(rootDir) {
  const errors = [];
  for (const file of [
    "docs/product/product-decisions.md",
    "docs/product/product-scope.md",
    "docs/product/naming-and-slogan.md",
    "CONTEXT.md",
  ]) {
    readRequired(rootDir, file, errors);
  }
  for (const directory of ["docs/guides", "docs/agents"]) {
    listRequiredDirectory(rootDir, directory, errors);
  }

  const map = readRequired(rootDir, "docs/README.md", errors);
  if (map !== undefined) {
    for (const target of [
      "adr/",
      "specs/",
      "product/product-decisions.md",
      "product/product-scope.md",
      "product/naming-and-slogan.md",
      "guides/",
      "../README.md",
      "../README.zh-Hans.md",
      "../AGENTS.md",
      "../CONTEXT.md",
      "agents/",
    ]) {
      if (!hasNavigationLink(map, target)) {
        errors.push(`docs/README.md: missing formal module link ${target}`);
      }
    }
  }

  const readmeContracts = [
    {
      file: "README.md",
      links: ["README.zh-Hans.md", "docs/README.md", "docs/product/product-scope.md"],
    },
    {
      file: "README.zh-Hans.md",
      links: ["README.md", "docs/README.md", "docs/product/product-scope.md"],
    },
  ];
  for (const contract of readmeContracts) {
    const document = readRequired(rootDir, contract.file, errors);
    if (document === undefined) continue;
    for (const target of contract.links) {
      if (!hasNavigationLink(document, target)) {
        errors.push(`${contract.file}: missing navigation link ${target}`);
      }
    }
  }

  const agents = readRequired(rootDir, "AGENTS.md", errors);
  if (agents !== undefined) {
    if (!hasNavigationLink(agents, "docs/README.md")) {
      errors.push("AGENTS.md: missing navigation link docs/README.md");
    }
  }

  return errors;
}

export function validateDocumentation(rootDir = process.cwd()) {
  const resolvedRoot = path.resolve(rootDir);
  return [
    ...validateAdrIndex(resolvedRoot),
    ...validateSpecIndex(resolvedRoot),
    ...validateNavigation(resolvedRoot),
  ].sort();
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const errors = validateDocumentation();
  if (errors.length === 0) {
    console.log("Documentation contracts passed.");
  } else {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
  }
}
