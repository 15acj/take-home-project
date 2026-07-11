// Academic citation graph dataset.
// Fields (topic clusters) each get a hue used for node color.
export const FIELDS = {
  genetics:     { label: "Genetics & Molecular Biology", hue: 145, rgb: [70, 220, 150] },
  ai:           { label: "Machine Learning & AI",        hue: 190, rgb: [64, 208, 240] },
  physics:      { label: "Physics",                      hue: 255, rgb: [140, 150, 255] },
  chemistry:    { label: "Chemistry & Materials",        hue: 40,  rgb: [255, 176, 84] },
  medicine:     { label: "Medicine & Clinical",          hue: 355, rgb: [255, 110, 130] },
  neuro:        { label: "Neuroscience",                 hue: 300, rgb: [214, 122, 255] },
  cs:           { label: "Computer Science & Math",      hue: 168, rgb: [72, 224, 206] },
  economics:    { label: "Economics & Social Science",   hue: 50,  rgb: [240, 206, 96] },
};

// Real, famous, highly-cited papers used as recognizable anchor nodes.
const SEED_PAPERS = [
  ["Molecular Structure of Nucleic Acids", "Watson, Crick", 1953, "genetics", 12800],
  ["A Method for the Isolation of DNA (Southern blot)", "Southern", 1975, "genetics", 34000],
  ["Cleavage of Structural Proteins (SDS-PAGE)", "Laemmli", 1970, "genetics", 220000],
  ["Protein Measurement with the Folin Phenol Reagent", "Lowry et al.", 1951, "chemistry", 305000],
  ["A Programmable Dual-RNA Guided DNA Endonuclease (CRISPR)", "Jinek, Doudna, Charpentier", 2012, "genetics", 15600],
  ["DNA Sequencing with Chain-Terminating Inhibitors", "Sanger et al.", 1977, "genetics", 65000],
  ["Basic Local Alignment Search Tool (BLAST)", "Altschul et al.", 1990, "genetics", 100000],
  ["Initial Sequencing of the Human Genome", "Lander et al.", 2001, "genetics", 25000],

  ["ImageNet Classification with Deep CNNs (AlexNet)", "Krizhevsky, Sutskever, Hinton", 2012, "ai", 135000],
  ["Deep Residual Learning (ResNet)", "He et al.", 2016, "ai", 190000],
  ["Attention Is All You Need (Transformer)", "Vaswani et al.", 2017, "ai", 120000],
  ["Adam: A Method for Stochastic Optimization", "Kingma, Ba", 2015, "ai", 170000],
  ["Generative Adversarial Networks", "Goodfellow et al.", 2014, "ai", 75000],
  ["Long Short-Term Memory", "Hochreiter, Schmidhuber", 1997, "ai", 90000],
  ["Gradient-Based Learning Applied to Document Recognition", "LeCun et al.", 1998, "ai", 60000],
  ["BERT: Pre-training of Deep Bidirectional Transformers", "Devlin et al.", 2019, "ai", 90000],
  ["Dropout: A Simple Way to Prevent Overfitting", "Srivastava et al.", 2014, "ai", 45000],

  ["Can Quantum-Mechanical Description Be Considered Complete? (EPR)", "Einstein, Podolsky, Rosen", 1935, "physics", 22000],
  ["The Large-Scale Structure of Space-Time", "Hawking, Ellis", 1973, "physics", 16000],
  ["A Model of Leptons", "Weinberg", 1967, "physics", 12000],
  ["Self-Consistent Equations (Kohn–Sham DFT)", "Kohn, Sham", 1965, "physics", 60000],
  ["Inhomogeneous Electron Gas", "Hohenberg, Kohn", 1964, "physics", 55000],
  ["Observation of Gravitational Waves", "LIGO Collaboration", 2016, "physics", 14000],
  ["Electric Field Effect in Atomically Thin Carbon (Graphene)", "Novoselov et al.", 2004, "physics", 62000],

  ["Generalized Gradient Approximation Made Simple (PBE)", "Perdew, Burke, Ernzerhof", 1996, "chemistry", 180000],
  ["Density-Functional Thermochemistry (B3LYP)", "Becke", 1993, "chemistry", 100000],
  ["Special Points for Brillouin-Zone Integrations", "Monkhorst, Pack", 1976, "chemistry", 55000],
  ["Efficient Iterative Schemes for Ab Initio (VASP)", "Kresse, Furthmüller", 1996, "chemistry", 90000],

  ["The Diagnostic and Statistical Manual (DSM)", "APA", 1994, "medicine", 80000],
  ["A New Method of Estimating Survival (Kaplan–Meier)", "Kaplan, Meier", 1958, "medicine", 65000],
  ["Global Cancer Statistics (GLOBOCAN)", "Bray et al.", 2018, "medicine", 90000],
  ["Regression Models and Life-Tables (Cox)", "Cox", 1972, "medicine", 55000],
  ["A Novel Coronavirus from Patients with Pneumonia", "Zhu et al.", 2020, "medicine", 40000],

  ["Receptive Fields of Single Neurones in the Cat's Visual Cortex", "Hubel, Wiesel", 1962, "neuro", 18000],
  ["The Organization of Behavior (Hebbian learning)", "Hebb", 1949, "neuro", 30000],
  ["A Quantitative Description of Membrane Current (Hodgkin–Huxley)", "Hodgkin, Huxley", 1952, "neuro", 25000],

  ["Computing Machinery and Intelligence", "Turing", 1950, "cs", 20000],
  ["A Mathematical Theory of Communication", "Shannon", 1948, "cs", 100000],
  ["The PageRank Citation Ranking", "Page, Brin et al.", 1999, "cs", 18000],
  ["A Relational Model of Data for Large Shared Banks", "Codd", 1970, "cs", 12000],

  ["A Theory of Justice", "Rawls", 1971, "economics", 55000],
  ["Prospect Theory: Decision Under Risk", "Kahneman, Tversky", 1979, "economics", 75000],
  ["The Market for Lemons", "Akerlof", 1970, "economics", 40000],
  ["Judgment under Uncertainty: Heuristics and Biases", "Tversky, Kahneman", 1974, "economics", 60000],
];

// deterministic PRNG
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLE_A = ["Scalable","Robust","Deep","Quantum","Bayesian","Nonlinear","Adaptive","Emergent","High-Throughput","Structural","Dynamic","Generative","Stochastic","Topological","Self-Assembled","Distributed","Efficient","Probabilistic","Hierarchical","Multiscale"];
const TITLE_B = ["Framework for","Analysis of","Approach to","Model of","Methods for","Dynamics of","Regulation of","Estimation of","Characterization of","Optimization of","Inference in","Mechanisms of","Simulation of","Detection of","Control of"];
const FIELD_NOUNS = {
  genetics:  ["Gene Expression","Protein Folding","Genome Assembly","RNA Interference","Epigenetic Regulation","Cell Signaling"],
  ai:        ["Neural Representation","Reinforcement Learning","Sequence Modeling","Graph Networks","Self-Supervision","Language Understanding"],
  physics:   ["Quantum Entanglement","Phase Transitions","Dark Matter","Superconductivity","Field Theory","Cosmic Structure"],
  chemistry: ["Catalytic Surfaces","Molecular Dynamics","Reaction Kinetics","Crystal Growth","Battery Electrodes","Photochemistry"],
  medicine:  ["Tumor Progression","Immune Response","Clinical Outcomes","Drug Delivery","Disease Screening","Vaccine Efficacy"],
  neuro:     ["Cortical Circuits","Synaptic Plasticity","Memory Encoding","Neural Oscillations","Sensory Coding","Decision Making"],
  cs:        ["Distributed Systems","Approximation Algorithms","Cryptographic Protocols","Data Structures","Complexity Bounds","Network Flow"],
  economics: ["Market Equilibria","Behavioral Bias","Game-Theoretic Strategy","Labor Dynamics","Social Choice","Risk Preference"],
};
const AUTHORS = ["Zhang","Kumar","Müller","Chen","Silva","Okafor","Ivanov","Tanaka","Rossi","Nguyen","Andersson","Cohen","Park","Dubois","Haldane","Fischer","Sato","Kim","Novak","Reyes"];

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const VENUES = {
  genetics:  ["Nature Genetics","Cell","Nucleic Acids Research","Genome Research"],
  ai:        ["NeurIPS","ICML","CVPR","Journal of Machine Learning Research"],
  physics:   ["Physical Review Letters","Reviews of Modern Physics","Nature Physics","Physical Review D"],
  chemistry: ["Journal of the American Chemical Society","Nature Materials","Physical Review B","Angewandte Chemie"],
  medicine:  ["The Lancet","New England Journal of Medicine","JAMA","Nature Medicine"],
  neuro:     ["Neuron","Journal of Neuroscience","Nature Neuroscience","Brain"],
  cs:        ["Communications of the ACM","Journal of the ACM","Proceedings of STOC","IEEE Transactions on Information Theory"],
  economics: ["American Economic Review","Econometrica","Quarterly Journal of Economics","Journal of Political Economy"],
};
const ABS_OPEN = ["We present","We introduce","We propose","This paper develops","Here we report","We describe"];
const ABS_APPROACH = ["a principled framework","a scalable method","a unifying theoretical account","an empirical study","a general algorithm","a systematic analysis"];
const ABS_BODY = [
  "Our approach combines established techniques with a novel formulation that improves robustness and interpretability.",
  "We derive the governing relationships from first principles and validate them across a wide range of conditions.",
  "The method requires no additional supervision and scales gracefully to large problem sizes.",
  "We characterize the key trade-offs and identify the regimes in which the effect is strongest.",
  "Extensive experiments compare against strong baselines under carefully controlled settings.",
];
const ABS_RESULT = [
  "Results show consistent gains over prior work.",
  "We observe a substantial and reproducible improvement.",
  "The findings resolve a long-standing ambiguity in the literature.",
  "Performance matches or exceeds the current state of the art.",
  "The predicted behavior is confirmed to high precision.",
];
const ABS_CLOSE = [
  "We discuss implications for future study and release our materials to the community.",
  "These results suggest a broadly applicable underlying principle.",
  "We conclude by outlining the open questions raised by this work.",
  "The work opens several promising directions for further research.",
  "Together these contributions meaningfully advance the field.",
];
const pick = (r, arr)=> arr[Math.floor(r()*arr.length)];

// Build the full graph. capNodes caps total generated nodes.
export function buildGraph(capNodes = 2400) {
  const rand = mulberry32(20260709);
  const fieldKeys = Object.keys(FIELDS);
  const nodes = [];
  let id = 0;

  // seed papers
  for (const [title, authors, year, field, cites] of SEED_PAPERS) {
    nodes.push({ id: id++, title, authors, year, field, citations: cites, famous: true });
  }

  // procedural fill
  while (nodes.length < capNodes) {
    const field = fieldKeys[Math.floor(rand() * fieldKeys.length)];
    const nouns = FIELD_NOUNS[field];
    const title = `${TITLE_A[Math.floor(rand()*TITLE_A.length)]} ${TITLE_B[Math.floor(rand()*TITLE_B.length)]} ${nouns[Math.floor(rand()*nouns.length)]}`;
    const nAuth = 1 + Math.floor(rand() * 4);
    const auth = [];
    for (let i = 0; i < nAuth; i++) auth.push(AUTHORS[Math.floor(rand()*AUTHORS.length)]);
    const authors = auth.slice(0, 2).join(", ") + (nAuth > 2 ? " et al." : "");
    const year = 1960 + Math.floor(rand() * 65);
    // power-law-ish citation counts
    const cites = Math.floor(200 + Math.pow(rand(), 3.2) * 40000);
    nodes.push({ id: id++, title, authors, year, field, citations: cites, famous: false });
  }

  // sort by citations desc so "top N" filtering is meaningful; reassign rank
  nodes.sort((a, b) => b.citations - a.citations);
  nodes.forEach((n, i) => { n.rank = i + 1; });

  // enrich each node with an abstract, venue and full publication date (deterministic per id)
  for (const n of nodes) {
    const r = mulberry32(0x9e37 + n.id * 2654435761);
    const nouns = FIELD_NOUNS[n.field];
    const topic = pick(r, nouns).toLowerCase();
    n.abstract = `${pick(r, ABS_OPEN)} ${pick(r, ABS_APPROACH)} for ${topic} in ${FIELDS[n.field].label.toLowerCase()}. ${pick(r, ABS_BODY)} ${pick(r, ABS_RESULT)} ${pick(r, ABS_CLOSE)}`;
    n.venue = pick(r, VENUES[n.field]);
    const month = Math.floor(r() * 12);
    const day = 1 + Math.floor(r() * 28);
    n.pubDate = `${MONTHS[month]} ${day}, ${n.year}`;
    n.doi = `10.${1000 + (n.id % 8999)}/${n.field}.${(n.year)}.${1000 + (n.id % 8999)}`;
    // availability flags (deterministic). Open access ~ younger papers skew open.
    const oaBias = n.year >= 2005 ? 0.62 : 0.34;
    n.openAccess = r() < oaBias;
    // a PDF link exists for most OA papers and a minority of closed ones
    n.hasPdf = n.openAccess ? r() < 0.92 : r() < 0.14;
    // GROBID-parsed full-text XML exists only where we have a PDF, and not always
    n.hasGrobid = n.hasPdf ? r() < 0.6 : false;
  }

  // edges: each node cites a few higher-ranked (more-cited) papers, biased same-field
  const edges = [];
  const byField = {};
  fieldKeys.forEach(f => byField[f] = []);
  nodes.forEach(n => byField[n.field].push(n));

  for (const n of nodes) {
    if (n.rank === 1) continue;
    const nEdges = 1 + Math.floor(rand() * 3);
    for (let e = 0; e < nEdges; e++) {
      let target;
      if (rand() < 0.82) {
        // same field, more cited
        const pool = byField[n.field].filter(t => t.rank < n.rank);
        if (!pool.length) continue;
        // prefer well-cited: pick from top slice
        target = pool[Math.floor(Math.pow(rand(), 1.8) * pool.length)];
      } else {
        // cross-field link to a highly cited paper
        target = nodes[Math.floor(Math.pow(rand(), 2.5) * Math.min(nodes.length, 200))];
      }
      if (target && target.id !== n.id) {
        edges.push({ source: n.id, target: target.id, cross: target.field !== n.field });
      }
    }
  }
  // dedupe edges
  const seen = new Set();
  const uniqueEdges = [];
  for (const ed of edges) {
    const k = ed.source < ed.target ? ed.source + "-" + ed.target : ed.target + "-" + ed.source;
    if (seen.has(k)) continue;
    seen.add(k);
    uniqueEdges.push(ed);
  }

  return { nodes, edges: uniqueEdges };
}
