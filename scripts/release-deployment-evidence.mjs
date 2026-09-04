import fs from "node:fs";
import path from "node:path";

const controllerVersion = "v1.9.1";
const controllerImage = "quay.io/argoproj/argo-rollouts@sha256:15c0d41f2c69a382d4399bcb28ed4f03ee9f58b56cfc9e6cd55bcbf0f311c06d";

function validateImages(rendered, values, images, label, assert) {
  for (const line of rendered.split(/\r?\n/)) {
    const match = /^[ \t]*image:[ \t]*["']?([^\s"']+)["']?[ \t]*$/.exec(line);
    if (match) assert(/@sha256:[0-9a-f]{64}$/.test(match[1]), `${label} has a mutable image: ${match[1]}.`);
  }
  for (const image of images) {
    const reference = `${image.image}@${image.digest}`;
    assert(rendered.includes(`image: ${reference}`), `${label} is not bound to ${image.component} digest.`);
    assert(values.includes(`image: "${reference}"`), `Release values are not bound to ${image.component} digest.`);
  }
  assert(rendered.includes("ASSETLIBRARY_APP_UPDATES_ENABLED") && rendered.includes('value: "false"'), `${label} must keep App Update disabled.`);
}

function documentWith(documents, kind, name) {
  return documents.find((document) =>
    new RegExp(`^kind:[ \\t]+${kind}[ \\t]*$`, "m").test(document)
    && document.includes(`metadata:\n  name: ${name}\n`));
}

export function validateDeployment({ output, images, assert, boundedFile }) {
  const manifestPath = path.join(output, "deployment/manifest.yaml");
  const progressivePath = path.join(output, "deployment/progressive-manifest.yaml");
  boundedFile(manifestPath, "Rendered Helm manifest");
  boundedFile(progressivePath, "Rendered progressive Helm manifest");
  const rendered = fs.readFileSync(manifestPath, "utf8");
  const progressive = fs.readFileSync(progressivePath, "utf8");
  const values = fs.readFileSync(path.join(output, "deployment/values.yaml"), "utf8");
  validateImages(rendered, values, images, "Rendered deployment", assert);
  validateImages(progressive, values, images, "Rendered progressive deployment", assert);
  assert(values.includes("appUpdatesEnabled: false"), "Release values must keep App Update disabled.");

  const documents = progressive.split(/^[ \t]*---[ \t]*$/m);
  const rollouts = documents.filter((document) => /^kind:[ \t]+Rollout[ \t]*$/m.test(document));
  assert(rollouts.length === 2, "Progressive deployment must contain exactly API and web Rollouts.");
  const components = new Set();
  for (const rollout of rollouts) {
    const component = /^[ \t]+app\.kubernetes\.io\/component:[ \t]+(api|web)[ \t]*$/m.exec(rollout)?.[1];
    assert(component && !components.has(component), "Progressive Rollouts must uniquely identify API and web.");
    components.add(component);
    const weights = [...rollout.matchAll(/^[ \t]+- setWeight:[ \t]+([0-9]+)[ \t]*$/gm)].map((match) => Number(match[1]));
    assert(JSON.stringify(weights) === JSON.stringify([5, 25, 100]), `${component} Rollout must use exact 5/25/100 weights.`);
    assert(rollout.includes(`assetlibrary.neuro/required-rollouts-version: "${controllerVersion}"`), `${component} Rollout controller version is not pinned.`);
    assert(rollout.includes(`assetlibrary.neuro/required-rollouts-image: "${controllerImage}"`), `${component} Rollout controller image is not pinned.`);
    for (const marker of ["progressDeadlineAbort: true", `stableService: assetlibrary-${component}`, `canaryService: assetlibrary-${component}-canary`, `stableIngress: assetlibrary-${component}`, `templateName: assetlibrary-${component}-canary`]) {
      assert(rollout.includes(marker), `${component} Rollout is missing ${marker}.`);
    }
  }

  for (const component of ["api", "web"]) {
    const stable = documentWith(documents, "Service", `assetlibrary-${component}`);
    const canary = documentWith(documents, "Service", `assetlibrary-${component}-canary`);
    const ingress = documentWith(documents, "Ingress", `assetlibrary-${component}`);
    const analysis = documentWith(documents, "AnalysisTemplate", `assetlibrary-${component}-canary`);
    assert(stable?.includes("assetlibrary.neuro/track: stable"), `${component} stable Service is not track-labeled.`);
    assert(canary?.includes("assetlibrary.neuro/track: canary"), `${component} canary Service is not track-labeled.`);
    assert(ingress?.includes(`                name: assetlibrary-${component}\n`) && ingress.includes("nginx.ingress.kubernetes.io/ssl-redirect"), `${component} stable Ingress is not TLS routed to its Service.`);
    assert(analysis, `${component} AnalysisTemplate is missing.`);
  }
  const apiAnalysis = documentWith(documents, "AnalysisTemplate", "assetlibrary-api-canary");
  const webAnalysis = documentWith(documents, "AnalysisTemplate", "assetlibrary-web-canary");
  assert(apiAnalysis.includes('service="assetlibrary-api",rollout_track="canary"'), "API analysis is not bound to the application service label and canary scrape target.");
  assert(webAnalysis.includes('ingress="assetlibrary-web-assetlibrary-web-canary"'), "Web analysis is not bound to the Argo-generated canary Ingress name.");
  assert(progressive.includes("sourceLabels: [__meta_kubernetes_service_label_assetlibrary_neuro_track]") && progressive.includes("targetLabel: rollout_track"), "Progressive metrics do not preserve stable/canary scrape identity.");
  assert((progressive.match(/failureLimit:[ \t]+0/g) ?? []).length === 8, "Progressive analysis must fail closed for all eight metrics.");
  for (const marker of ["api-canary-request-rate", "api-canary-5xx-ratio", "api-canary-p95", "web-canary-request-rate", "web-canary-5xx-ratio", "web-canary-p95", "global-slo-alerts"]) {
    assert(progressive.includes(marker), `Progressive deployment is missing ${marker}.`);
  }
}
