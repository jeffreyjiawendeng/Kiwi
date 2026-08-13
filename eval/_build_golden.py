"""Builds golden.json from the (query, quote) pairs below.

Not part of the harness itself. Every quote was read directly out of the
real GROBID-extracted text for its paper and copied verbatim; this
script's only job is to verify each quote is still an exact, unique
substring of the current ingestion and compute its offsets. Re-run after
re-ingesting eval/corpus/ (e.g. a new GROBID version) to catch any quote
that no longer matches. kiwi.evaluation.metrics.locate() also re-resolves
offsets at evaluation time via the same quote-selector Anchor uses, so a
small amount of drift does not by itself invalidate the golden set. See
eval/README.md.

Run from the repository root after ingesting the corpus:
    uv run kiwi ingest eval/corpus --project eval/workspace.kiwi
    uv run python eval/_build_golden.py
"""

import json
from pathlib import Path

WORKSPACE = Path("eval/workspace.kiwi/papers")

DOCS = {
    "betweenness_centrality": "doc_3c1ceac223d5c007",
    "blockchain_testing": "doc_e69e869cd3bc9a82",
    "intrusion_detection": "doc_659ff570e8044f39",
    "daas_protocols": "doc_b48982da46d1815a",
    "edge_iot_ecc": "doc_26c8a1141139da12",
}

PAIRS = [
    # betweenness_centrality
    (
        "betweenness_centrality",
        "What time and storage complexity does the naive algorithm for betweenness centrality require?",
        "the naive algorithm requires O(N 3 ) time and O(N 2 ) storage, regardless of the algorithms implemented to find the shortest paths",
    ),
    (
        "betweenness_centrality",
        "What programming language and hardware were used for the numerical experiments?",
        "Algorithms are coded in C and run on a PC with an Intel Core 2 Quad CPU (2.66 GHz, 6 Mb) and 6 Gb of RAM",
    ),
    (
        "betweenness_centrality",
        "How much faster is the VN algorithm than Brandes' algorithm at a network size of 50,000?",
        "When the network size is 50,000, the VN algorithm is 3 and 1.5 times faster than the Brandes' algorithm, for average network degrees of 2 and 10, respectively.",
    ),
    (
        "betweenness_centrality",
        "Under what network conditions does the VN algorithm fail to outperform Brandes' algorithm?",
        "it can hardly outperform the Brandes' algorithm when the network is dense and weighted with large values.",
    ),
    (
        "betweenness_centrality",
        "What is the core idea behind representing weighted edges with virtual nodes?",
        "an integer-weighted network can be broken down into a simple unweighted network with virtual nodes, such that the calculation of shortest paths in Step 1 can be solved as a breadth-first search (BFS) problem.",
    ),
    (
        "betweenness_centrality",
        "What other shortest-path-based network properties could the VN algorithm generalize to?",
        "the VN algorithm can easily be generalized to calculate other shortest path based network properties, such as closeness centrality [33], graph centrality [34], stress centrality [35], and so on.",
    ),
    (
        "betweenness_centrality",
        "What assumption does the analysis make about self loops in the network?",
        "we consider strongly connected networks [22] with no self loops (acyclic).",
    ),
    (
        "betweenness_centrality",
        "Why is removing high-betweenness-centrality nodes considered harmful to network robustness?",
        "in the study of networks vulnerability to attacks, the removal of nodes with the highest betweenness centrality is shown to be one of the most harmful strategies that can break down the networks [8]",
    ),
    (
        "betweenness_centrality",
        "How many virtual nodes are inserted when replacing the example edges e_AC and e_BC?",
        "edge e AC and e BC are replaced by 3 and 2 unit edge segments with two and one virtual nodes inserted, respectively.",
    ),
    (
        "betweenness_centrality",
        "How many simulations were averaged to obtain the reported running times?",
        "all the following reported running times are the average of 100 simulations.",
    ),
    # blockchain_testing
    (
        "blockchain_testing",
        "How many studies did the Xie et al. survey on blockchain security threats cover?",
        "The review starts with a survey conducted by Xie et al., comprising 56 studies [17].",
    ),
    (
        "blockchain_testing",
        "What three criteria did Smith's survey propose as success predictors for blockchain-based data management projects?",
        "The authors suggested three criteria as success predictors for blockchain-based data management projects: dependability, security and trust.",
    ),
    (
        "blockchain_testing",
        "What tool converts software source code into a sequence diagram in the proposed system?",
        "Sequence Diagram Generator: A tool used to convert the software source code to a sequence diagram.",
    ),
    (
        "blockchain_testing",
        "What programming language and framework were used to write and deploy the system's smart contracts?",
        "The system smart contracts were written using the Solidity programming language, where the truffle framework, an Ethereum smart contract development tool, was used to test, compile and deploy system smart contracts.",
    ),
    (
        "blockchain_testing",
        "What four metrics were used to evaluate Transaction and Query operations?",
        "Transaction throughput, Query throughput, Transaction latency and Query latency.",
    ),
    (
        "blockchain_testing",
        "What does Blockchain Level 1 provide in the proposed framework?",
        "Blockchain Level 1: Provides a decentralised infrastructure for storing and managing trusted software behaviour.",
    ),
    (
        "blockchain_testing",
        "What data structure is used to store trusted and run-time software behaviour for efficient retrieval?",
        "For efficient data retrieval and validation, trusted software behaviour and run-time software behaviour are each stored in a mapping data structure.",
    ),
    (
        "blockchain_testing",
        "Why are distributed systems considered superior to centralised systems according to the introduction?",
        "distributed systems have superior reliability, availability and incremental scaling potential.",
    ),
    (
        "blockchain_testing",
        "What conditions justify using blockchain for the proposed software behaviour verification mechanism?",
        "there are multiple writers (software developer, software user and software tester), there is no Trusted Third Party (TTP), all writers are known, but some are not trusted, and finally, the software behaviour state should be publicly verifiable.",
    ),
    (
        "blockchain_testing",
        "What cloud platform provided the infrastructure for the level-1 and level-2 blockchains in the performance evaluation?",
        "we utilised eight virtual machines running on Google Compute Engine (https://cloud.google.com) to provide the infrastructure for level-1 and level-2 blockchains.",
    ),
    # intrusion_detection
    (
        "intrusion_detection",
        "Which dataset was used for training and evaluating the intrusion detection model?",
        "The study used the publicly accessible CSE-CIC-IDS2018 dataset, created by the University of New Brunswick for analyzing distributed Denial-Of-Service (DDoS) data",
    ),
    (
        "intrusion_detection",
        "How many nodes and edges does the constructed graph contain?",
        "The graph consists of 14 different node features, 3 classes, 70554 nodes and 831794 undirected edges.",
    ),
    (
        "intrusion_detection",
        "What accuracy did GConvTrans achieve on the held-out test set?",
        "On the held-out test set, GConvTrans achieved a final loss of 0.1488 and accuracy of 96.94% (Fig 5).",
    ),
    (
        "intrusion_detection",
        "What technique was used to oversample minority classes during preprocessing?",
        "We apply SMOTE to oversample the minority classes as a mean to minimize skew towards the majority class.",
    ),
    (
        "intrusion_detection",
        "What is a key limitation of this study regarding dataset diversity?",
        "the study only analyzed one dataset, which is the the CIC-IDS 2018 (Feb 14 subset).",
    ),
    (
        "intrusion_detection",
        "What two neural network components are combined in the proposed hybrid architecture?",
        "combining a graph neural network and a transformer encoder layer, for network intrusion detection systems (NIDS) in IoT devices.",
    ),
    (
        "intrusion_detection",
        "How were rows grouped together when building the graph from tabular data?",
        "We the group the various rows into clusters based on the time window and class in which they fall.",
    ),
    (
        "intrusion_detection",
        "How many nearest neighbors are used to form edges between nodes in the graph construction?",
        "Edges are then formed between each node (row or entry) and its closest 50 neighbors.",
    ),
    (
        "intrusion_detection",
        "What happens to validation accuracy within the first five epochs of training?",
        "training loss falls sharply from around 1.0 to 0.46, and validation loss from 0.93 to 0.33, a corresponding jump in validation accuracy from 57% to 86%.",
    ),
    (
        "intrusion_detection",
        "What role do the transformer encoder layers play in the hybrid architecture?",
        "The transformer encoder layers integrate the global context from distant nodes using multiple self-attention heads.",
    ),
    # daas_protocols
    (
        "daas_protocols",
        "Which five remote desktop protocols were compared in this study?",
        "we compare the remote desktop protocols RDP, ICA, PCoIP, RFB, and Team-Viewer.",
    ),
    (
        "daas_protocols",
        "What hardware specification was used for the Amazon WorkSpaces PCoIP evaluation?",
        "This is a Windows 7 installation on one CPU core running at 2.4 GHz and using 2 GB of RAM.",
    ),
    (
        "daas_protocols",
        "What tool was used to record user actions for the experiments?",
        "We recorded user actions (keyboard presses and mouse movement events) using the Macro Recorder tool [42].",
    ),
    (
        "daas_protocols",
        "What method was used to generate synthetic FBM traffic traces?",
        "we used the Random Midpoint Displacement (RMD) method, a fast and efficient generation method adequate for qualitative studies [66].",
    ),
    (
        "daas_protocols",
        "What metric is used to derive a Mean Opinion Score in this study's video quality comparison?",
        "we compare the video stream at the source and destination and from a Peak Signal-to-Noise Ratio (PSNR) measurement, we conclude a Mean Opinion Score (MOS) value.",
    ),
    (
        "daas_protocols",
        "Which cloud datacentre location was chosen for the remote desktop servers, and why?",
        "We selected the Amazon datacentre in Ireland owing to its close location to our remote desktop clients in Spain.",
    ),
    (
        "daas_protocols",
        "What three user profiles were defined to measure remote desktop performance?",
        "we defined three user profiles similar to those in [40] [41]: office, web browsing, and video user profiles.",
    ),
    (
        "daas_protocols",
        "What method was used to estimate the Hurst parameter for remote desktop traffic?",
        "In this paper, we use the variance aggregation plot, similar to many previous works [54] [58].",
    ),
    (
        "daas_protocols",
        "What was the maximum downstream link rate observed for the office user profile?",
        "the downstream link rate approached 900 Kb/s when large changes occurred on the screen, for example, when a new document window was opened or a large image was inserted.",
    ),
    (
        "daas_protocols",
        "What is the risk of using UDP transport for remote desktop protocols regarding packet size?",
        "the remote desktop protocols that use UDP as a transport protocol (PCoIP and Team-Viewer) do not reach the maximum packet size that the path MTU allows.",
    ),
    # edge_iot_ecc
    (
        "edge_iot_ecc",
        "What three main entities make up the proposed network model?",
        "The proposed network model consisted of mainly three essential entities: the sensor/IoT device, the gateway node, and the edge server.",
    ),
    (
        "edge_iot_ecc",
        "Which two threat models does this research rely on?",
        "This research utilizes the threat models established by Canetti-Krawczyk (CK) [62] and Dolev-Yao (DY) [63].",
    ),
    (
        "edge_iot_ecc",
        "What software toolkit was used to formally validate the proposed protocol?",
        "involved simulating the proposed protocol using the esteemed software verification toolkit ProVerif [67].",
    ),
    (
        "edge_iot_ecc",
        "How long is the ECC key used to help resist replay attacks in the protocol?",
        "the proposed protocol, fortified with a 160-bit long ECC key, 60-bit random numbers, secret keys, curve points, and unique identities, is designed to prevent such attacks.",
    ),
    (
        "edge_iot_ecc",
        "What three cryptographic primitives does the proposed authentication protocol utilize?",
        "this article presents an authentication protocol that utilizes elliptic curve cryptography (ECC), SHA2, and XOR operations.",
    ),
    (
        "edge_iot_ecc",
        "What does the IoT device layer connect according to the edge-IoT ecosystem description?",
        "The IoT device layer connects the real and virtual worlds to an edge server [13].",
    ),
    (
        "edge_iot_ecc",
        "Why is data secrecy considered essential rather than merely desirable in the edge-IoT security requirements?",
        "Data secrecy is not just a desirable feature, but an essential one to prevent data from being disclosed.",
    ),
    (
        "edge_iot_ecc",
        "What does the middleware layer serve as in the IoT architecture?",
        "The middleware layer serves as more than just a line between the network and application layers",
    ),
    (
        "edge_iot_ecc",
        "What curve and field does the gateway node select during the setup phase?",
        "the gateway node (GWN) meticulously selects a curve E P (x, y) over a finite field F P and chooses a point",
    ),
    (
        "edge_iot_ecc",
        "What does the timestamp check at each round trip protect the protocol against?",
        "which strongly prohibits the adversary from launching a replay attack.",
    ),
]

golden = []
errors = []
for key, query, quote in PAIRS:
    doc_id = DOCS[key]
    text_path = WORKSPACE / doc_id / "text.txt"
    text = text_path.read_text(encoding="utf-8")
    count = text.count(quote)
    if count != 1:
        errors.append((key, query, quote, count))
        continue
    start = text.index(quote)
    end = start + len(quote)
    golden.append(
        {
            "query": query,
            "document_id": doc_id,
            "anchor": {
                "start": start,
                "end": end,
                "exact": quote,
                "prefix": text[max(0, start - 32) : start],
                "suffix": text[end : end + 32],
            },
        }
    )

print(f"{len(golden)} verified, {len(errors)} problems")
for key, query, quote, count in errors:
    print(f"  PROBLEM ({count}x): {key}: {quote[:80]!r}")

if errors:
    raise SystemExit(1)

Path("eval/golden.json").write_text(
    json.dumps({"field": "computer science", "pairs": golden}, indent=2) + "\n",
    encoding="utf-8",
)
