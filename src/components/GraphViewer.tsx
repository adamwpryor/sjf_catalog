'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';

// Dynamically import ForceGraph2D on browser client-side to bypass Next.js SSR canvas errors
const ForceGraph2D = dynamic(
  () => import('react-force-graph-2d').then(mod => mod.default),
  { ssr: false }
);

// Dynamically import ForceGraph3D to support 3D WebGL mode
const ForceGraph3D = dynamic(
  () => import('react-force-graph-3d').then(mod => mod.default),
  { ssr: false }
);

interface GraphNode {
  id: string;
  label: string;
  title: string;
  description?: string;
  group: 'course' | 'program' | 'faculty' | 'department' | 'policy' | 'block';
  credits?: number;
  prerequisites_raw?: string;
  degree_type?: string;
  total_credits?: number;
  page_number?: number;
  sequence_order?: number;
  toulmin_role?: string;
  deontic_modality?: string;
  quinean_class?: string;
  x?: number;
  y?: number;
  color?: string;
}

interface GraphLink {
  source: string | { id: string };
  target: string | { id: string };
  type: 'PREREQUISITE' | 'COREQUISITE' | 'GOVERNS' | 'BELONGS_TO' | 'MENTIONS';
  is_required?: boolean;
  mention_type?: 'course' | 'program';
}

interface GraphViewerProps {
  catalogId: string;
  mode: 'curriculum' | 'policy';
}

// Visual Palette conforming to institution Crimson & Slate branding guidelines
// Visual Palette conforming to User Specification
/**
 * Get node color based on the group.
 *
 * @param {GraphNode} node - The node object.
 * @returns {string} The color string.
 */
const getNodeColor = (node: GraphNode) => {
  switch (node.group) {
    case 'course':
      return '#8C2232'; // Red - Courses
    case 'block':
      return '#f97316'; // Orange - Requirement Blocks
    case 'program':
      return '#eab308'; // Yellow - Programs of Study
    case 'department':
      return '#22c55e'; // Green - Departments
    case 'faculty':
      return '#3b82f6'; // Blue - Faculty
    case 'policy':
      return '#8b5cf6'; // Policy Purple/Indigo
    default:
      return '#475569';
  }
};

/**
 * Get link color.
 *
 * @param {any} link - The link object.
 * @param {boolean} isSelected - Whether the link is selected.
 * @param {boolean} isFaded - Whether the link is faded.
 * @returns {string} The color string.
 */
const getLinkColor = (link: any, isSelected: boolean, isFaded: boolean) => {
  if (isFaded) return 'rgba(148, 163, 184, 0.09)'; // Constellation visible connection

  const alpha = isSelected ? '0.95' : '0.45';
  const alphaGov = isSelected ? '0.95' : '0.5';

  switch (link.type) {
    case 'PREREQUISITE':
      return `rgba(140, 34, 50, ${alpha})`; // Primary brand crimson (#8C2232)
    case 'COREQUISITE':
      return `rgba(242, 169, 0, ${alpha})`; // Brand gold (#f2a900) for Co-requisites
    case 'SUPERVISES':
      return `rgba(234, 179, 8, ${alpha})`; // Yellow for Department -> Program
    case 'GOVERNS':
      return link.is_required 
        ? `rgba(59, 130, 246, ${alphaGov})`   // Blue for Required Program Block
        : `rgba(168, 85, 247, ${alphaGov})`; // Purple for Elective Program Block
    case 'BELONGS_TO': {
      const sourceId = typeof link.source === 'string' ? link.source : link.source?.id || '';
      if (sourceId.startsWith('faculty_')) {
        return `rgba(34, 197, 94, ${alpha})`; // Green for Faculty -> Department
      }
      return link.is_required
        ? `rgba(59, 130, 246, ${alphaGov})`   // Blue for Required course link
        : `rgba(168, 85, 247, ${alphaGov})`;  // Purple for Elective course link
    }
    case 'MENTIONS':
      return `rgba(245, 158, 11, ${isSelected ? '0.95' : '0.4'})`; // Amber for semantic policy mentions
    default:
      return isSelected ? '#B6CFD6' : 'rgba(148, 163, 184, 0.15)'; // Faint slate link
  }
};

/**
 * Interactive graph visualization for curriculum and policy data.
 *
 * @param {GraphViewerProps} props - The component properties.
 * @returns {JSX.Element} The graph viewer component.
 */
export default function GraphViewer({ catalogId, mode }: GraphViewerProps) {
  const fgRef = useRef<any>(null);
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);

  // 3D Visual Modes Toggle
  const [is3D, setIs3D] = useState(false);

  // Search & Filter UI States
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [selectedProgram, setSelectedProgram] = useState<string>('');
  const [selectedPrefix, setSelectedPrefix] = useState<string>('');
  const [showFilters, setShowFilters] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Pathfinding States
  const [pathMode, setPathMode] = useState(false);
  const [startNodeId, setStartNodeId] = useState<string>('');
  const [endNodeId, setEndNodeId] = useState<string>('');
  const [pathPath, setPathPath] = useState<Set<string>>(new Set());

  // Selection, Hover & History Stack States
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoverNode, setHoverNode] = useState<GraphNode | null>(null);
  const [neighbors, setNeighbors] = useState<Map<string, Set<string>>>(new Map());
  const [historyStack, setHistoryStack] = useState<GraphNode[]>([]);

  // Load Graph Data on catalog change
  useEffect(() => {
    if (!catalogId) return;

    async function loadGraph() {
      try {
        setLoading(true);
        setSelectedNode(null);
        setHoverNode(null);

        const res = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_graph', catalogId })
        });

        if (res.ok) {
          const data = await res.json();

          const cleanedNodes = data.nodes;
          const cleanedLinks = data.links;

          // Precompute Neighbors Map for O(1) hover lookups based on CLEANED links
          const nMap = new Map<string, Set<string>>();
          cleanedLinks.forEach((l: any) => {
            const s = typeof l.source === 'string' ? l.source : l.source.id;
            const t = typeof l.target === 'string' ? l.target : l.target.id;
            if (!nMap.has(s)) nMap.set(s, new Set());
            if (!nMap.has(t)) nMap.set(t, new Set());
            nMap.get(s)!.add(t);
            nMap.get(t)!.add(s);
          });

          setNeighbors(nMap);
          setGraphData({
            nodes: cleanedNodes,
            links: cleanedLinks
          });
        }
      } catch (err) {
        console.error("Failed to load prerequisites & policy graph: ", err);
      } finally {
        setLoading(false);
      }
    }
    loadGraph();
  }, [catalogId, mode]);

  // Dynamic client-side Programs Map Harvester (DFS Program -> Block -> Course)
  const programsMap = useMemo(() => {
    const pMap: Record<string, string[]> = {};
    if (graphData.nodes.length === 0) return pMap;

    // Build adjacency list for directional Governs/BelongsTo relations
    const adj = new Map<string, string[]>();
    graphData.links.forEach((l: any) => {
      const sId = typeof l.source === 'string' ? l.source : l.source.id;
      const tId = typeof l.target === 'string' ? l.target : l.target.id;
      if (!adj.has(sId)) adj.set(sId, []);
      adj.get(sId)!.push(tId);
    });

    const progNodes = graphData.nodes.filter(n => n.group === 'program');
    progNodes.forEach(p => {
      const courses = new Set<string>();
      const visited = new Set<string>();

      const queue = [p.id];
      visited.add(p.id);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const children = adj.get(curr) || [];
        children.forEach(child => {
          if (!visited.has(child)) {
            visited.add(child);
            const childNode = graphData.nodes.find(n => n.id === child);
            if (childNode) {
              if (childNode.group === 'course') {
                courses.add(child);
              } else {
                queue.push(child);
              }
            }
          }
        });
      }

      pMap[p.title || p.label] = Array.from(courses);
    });

    return pMap;
  }, [graphData]);

  // Unique Subject Prefix Harvester
  const prefixesList = useMemo(() => {
    const prefs = new Set<string>();
    graphData.nodes.forEach(n => {
      if (n.group === 'course') {
        const match = n.label.match(/^[A-Za-z]+/);
        if (match) prefs.add(match[0].toUpperCase());
      }
    });
    return Array.from(prefs).sort();
  }, [graphData]);

  // BFS Shortest Path calculator through prerequisite requirements
  const calculatePath = useCallback(() => {
    if (graphData.nodes.length === 0 || !startNodeId || !endNodeId) return;

    // Build undirected prerequisite adjacency map
    const adj = new Map<string, string[]>();
    graphData.links.forEach((l: any) => {
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      if (l.type === 'PREREQUISITE' || l.type === 'COREQUISITE') {
        if (!adj.has(s)) adj.set(s, []);
        if (!adj.has(t)) adj.set(t, []);
        adj.get(s)!.push(t);
        adj.get(t)!.push(s);
      }
    });

    const queue: string[][] = [[startNodeId]];
    const visited = new Set<string>([startNodeId]);
    let pathFound = false;

    while (queue.length > 0) {
      const currentPath = queue.shift()!;
      const node = currentPath[currentPath.length - 1];

      if (node === endNodeId) {
        setPathPath(new Set(currentPath));
        pathFound = true;
        break;
      }

      const neighborsList = adj.get(node) || [];
      for (const next of neighborsList) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push([...currentPath, next]);
        }
      }
    }

    if (!pathFound) {
      setPathPath(new Set([startNodeId, endNodeId]));
    }
  }, [graphData, startNodeId, endNodeId]);

  // Trigger BFS Path calculation on start/end change
  useEffect(() => {
    if (pathMode && startNodeId && endNodeId) {
      calculatePath();
    } else {
      setPathPath(new Set());
    }
  }, [pathMode, startNodeId, endNodeId, calculatePath]);

  // Click handler to zoom and focus camera with navigation history tracking
  const handleNodeClick = useCallback((node: any) => {
    setSelectedNode(prev => {
      if (prev && prev.id !== node.id) {
        setHistoryStack(stack => [...stack, prev]);
      }
      return node;
    });
    if (fgRef.current) {
      fgRef.current.centerAt(node.x, node.y, 800);
      fgRef.current.zoom(2.0, 800);
    }
  }, []);

  const handleNeighborClick = useCallback((neighborId: string) => {
    const node = graphData.nodes.find(n => n.id === neighborId);
    if (node) {
      handleNodeClick(node);
    }
  }, [graphData, handleNodeClick]);

  // Back navigation click handler
  const handleBackClick = useCallback(() => {
    if (historyStack.length === 0) return;
    const newStack = [...historyStack];
    const prevNode = newStack.pop()!;
    setHistoryStack(newStack);
    
    // Select the previous node directly without pushing it back onto the history
    setSelectedNode(prevNode);
    if (fgRef.current) {
      fgRef.current.centerAt(prevNode.x, prevNode.y, 800);
      fgRef.current.zoom(2.0, 800);
    }
  }, [historyStack]);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
    setHistoryStack([]);
    setPathPath(new Set());
  }, []);

  // View reset
  const handleResetView = useCallback(() => {
    setSelectedNode(null);
    setHoverNode(null);
    setSearchQuery('');
    setSelectedGroup('');
    setSelectedProgram('');
    setSelectedPrefix('');
    setPathMode(false);
    setStartNodeId('');
    setEndNodeId('');
    setPathPath(new Set());
    setHistoryStack([]);
    if (fgRef.current) {
      fgRef.current.zoomToFit(600);
    }
  }, []);

  // Precompute Search matches
  const { searchMatchIds, searchNeighborIds } = useMemo(() => {
    if (!searchQuery || graphData.nodes.length === 0) return { searchMatchIds: new Set<string>(), searchNeighborIds: new Set<string>() };

    const q = searchQuery.toLowerCase();
    const matches = new Set<string>();
    const nbrs = new Set<string>();

    graphData.nodes.forEach(n => {
      if (
        (n.label && n.label.toLowerCase().includes(q)) ||
        (n.title && n.title.toLowerCase().includes(q)) ||
        (n.description && n.description.toLowerCase().includes(q))
      ) {
        matches.add(n.id);
      }
    });

    if (matches.size > 0) {
      graphData.links.forEach((l: any) => {
        const sId = typeof l.source === 'string' ? l.source : l.source.id;
        const tId = typeof l.target === 'string' ? l.target : l.target.id;
        if (matches.has(sId)) nbrs.add(tId);
        if (matches.has(tId)) nbrs.add(sId);
      });
    }

    return { searchMatchIds: matches, searchNeighborIds: nbrs };
  }, [searchQuery, graphData]);

  // 2-Tier Neighbor and Link Highlight Resolver for localized context navigation
  const { primaryNeighborIds, secondaryNeighborIds, highlightLinkKeys } = useMemo(() => {
    const pIds = new Set<string>();
    const sIds = new Set<string>();
    const linkKeys = new Set<string>();

    if (!selectedNode) return { primaryNeighborIds: pIds, secondaryNeighborIds: sIds, highlightLinkKeys: linkKeys };

    const targetId = selectedNode.id;

    // 1. Get primary (Tier 1) neighbors from our neighbors map
    const direct = neighbors.get(targetId) || new Set<string>();
    direct.forEach(id => {
      pIds.add(id);
    });

    // 2. Discover secondary neighbors and links within 2 steps
    graphData.links.forEach((l: any) => {
      const sId = typeof l.source === 'string' ? l.source : l.source.id;
      const tId = typeof l.target === 'string' ? l.target : l.target.id;
      const linkKey = `${sId}-${tId}`;

      // A. Direct Link connected to selected node
      if (sId === targetId || tId === targetId) {
        linkKeys.add(linkKey);
      }
      // B. Indirect link connecting two primary neighbors
      else if (pIds.has(sId) && pIds.has(tId)) {
        linkKeys.add(linkKey);
      }
      // C. Secondary link connecting a primary neighbor to its own neighbor
      else if (pIds.has(sId)) {
        sIds.add(tId);
        linkKeys.add(linkKey);
      } else if (pIds.has(tId)) {
        sIds.add(sId);
        linkKeys.add(linkKey);
      }
    });

    // Clean sets to avoid overlaps
    sIds.delete(targetId);
    pIds.forEach(id => sIds.delete(id));

    return { primaryNeighborIds: pIds, secondaryNeighborIds: sIds, highlightLinkKeys: linkKeys };
  }, [selectedNode, neighbors, graphData]);

  // Advanced context-sensitive graph filter selector
  const filteredData = useMemo(() => {
    if (graphData.nodes.length === 0) return { nodes: [], links: [] };

    // SUBGRAPH ISOLATION ON NODE SELECTION:
    // If a node is selected, surgically isolate the entire canvas to ONLY include
    // the clicked node, its direct neighbors (Tier 1), and their neighbors (Tier 2).
    if (selectedNode) {
      const allowedNodeIds = new Set<string>();
      allowedNodeIds.add(selectedNode.id);

      // Direct (Tier 1) Neighbors
      const direct = neighbors.get(selectedNode.id) || new Set<string>();
      direct.forEach(id => {
        allowedNodeIds.add(id);
        // Secondary (Tier 2) Neighbors
        const secondary = neighbors.get(id) || new Set<string>();
        secondary.forEach(secId => allowedNodeIds.add(secId));
      });

      // Map allowed structures (two steps of removal)
      const nodes = graphData.nodes.filter(n => allowedNodeIds.has(n.id) && (mode === 'curriculum' ? n.group !== 'policy' : true));
      const nodeIds = new Set(nodes.map(n => n.id));
      const links = graphData.links.filter((l: any) => {
        const s = typeof l.source === 'string' ? l.source : l.source.id;
        const t = typeof l.target === 'string' ? l.target : l.target.id;
        return nodeIds.has(s) && nodeIds.has(t) && (mode === 'curriculum' ? l.type !== 'MENTIONS' : true);
      });

      return { nodes, links };
    }

    // 1. Separate by Mode
    let modeNodes = graphData.nodes;
    let modeLinks = graphData.links;

    if (mode === 'curriculum') {
      // Exclude policies to focus purely on courses, prerequisites, faculty, and program requirements
      modeNodes = graphData.nodes.filter(n => n.group !== 'policy');
      const nodeIds = new Set(modeNodes.map(n => n.id));
      modeLinks = graphData.links.filter((l: any) => {
        const sId = typeof l.source === 'string' ? l.source : l.source.id;
        const tId = typeof l.target === 'string' ? l.target : l.target.id;
        return nodeIds.has(sId) && nodeIds.has(tId) && l.type !== 'MENTIONS';
      });
    } else {
      // Policy mode: Show policy nodes, and only course/program nodes that are connected to policies
      const policyNodeIds = new Set(graphData.nodes.filter(n => n.group === 'policy').map(n => n.id));
      const connectedNodeIds = new Set<string>();

      graphData.links.forEach((l: any) => {
        if (l.type === 'MENTIONS') {
          const sId = typeof l.source === 'string' ? l.source : l.source.id;
          const tId = typeof l.target === 'string' ? l.target : l.target.id;
          if (policyNodeIds.has(sId)) connectedNodeIds.add(tId);
          if (policyNodeIds.has(tId)) connectedNodeIds.add(sId);
        }
      });

      const allowedNodeIds = new Set([...policyNodeIds, ...connectedNodeIds]);
      modeNodes = graphData.nodes.filter(n => allowedNodeIds.has(n.id));
      modeLinks = graphData.links.filter((l: any) => {
        const sId = typeof l.source === 'string' ? l.source : l.source.id;
        const tId = typeof l.target === 'string' ? l.target : l.target.id;
        return allowedNodeIds.has(sId) && allowedNodeIds.has(tId) && (l.type === 'MENTIONS' || l.type === 'GOVERNS');
      });
    }

    // 2. Apply Custom Program and Prefix dropdown filters (Curriculum Mode Only)
    if (mode === 'curriculum') {
      if (selectedProgram) {
        const courseIdsInProgram = programsMap[selectedProgram] || [];
        const allowedIds = new Set<string>(courseIdsInProgram);
        
        // Find the program node itself
        const progNode = modeNodes.find(n => n.group === 'program' && (n.title === selectedProgram || n.label === selectedProgram));
        if (progNode) allowedIds.add(progNode.id);
        
        // Retain block nodes that connect this program to its courses
        modeLinks.forEach((l: any) => {
          const sId = typeof l.source === 'string' ? l.source : l.source.id;
          const tId = typeof l.target === 'string' ? l.target : l.target.id;
          if (l.type === 'GOVERNS' && progNode && sId === progNode.id) {
            allowedIds.add(tId);
          }
        });

        // Recursively inherit prerequisite courses
        const pending = Array.from(allowedIds).filter(id => {
          const node = modeNodes.find(n => n.id === id);
          return node && node.group === 'course';
        });

        while (pending.length > 0) {
          const currId = pending.pop()!;
          modeLinks.forEach((l: any) => {
            if (l.type === 'PREREQUISITE' || l.type === 'COREQUISITE') {
              const sId = typeof l.source === 'string' ? l.source : l.source.id;
              const tId = typeof l.target === 'string' ? l.target : l.target.id;
              if (sId === currId && !allowedIds.has(tId)) {
                allowedIds.add(tId);
                pending.push(tId);
              }
              if (l.type === 'COREQUISITE' && tId === currId && !allowedIds.has(sId)) {
                allowedIds.add(sId);
                pending.push(sId);
              }
            }
          });
        }

        modeNodes = modeNodes.filter(n => allowedIds.has(n.id) || n.group === 'faculty');
        modeLinks = modeLinks.filter((l: any) => {
          const sId = typeof l.source === 'string' ? l.source : l.source.id;
          const tId = typeof l.target === 'string' ? l.target : l.target.id;
          return allowedIds.has(sId) && allowedIds.has(tId);
        });
      } else if (selectedPrefix) {
        const allowedIds = new Set<string>(
          modeNodes.filter(n => n.group === 'course' && n.label.toUpperCase().startsWith(selectedPrefix)).map(n => n.id)
        );

        // Keep track of the original prefix courses
        const prefixCourseIds = new Set<string>(allowedIds);

        // Recursively inherit prerequisites
        const pending = Array.from(allowedIds);
        while (pending.length > 0) {
          const currId = pending.pop()!;
          modeLinks.forEach((l: any) => {
            if (l.type === 'PREREQUISITE' || l.type === 'COREQUISITE') {
              const sId = typeof l.source === 'string' ? l.source : l.source.id;
              const tId = typeof l.target === 'string' ? l.target : l.target.id;
              if (sId === currId && !allowedIds.has(tId)) {
                allowedIds.add(tId);
                pending.push(tId);
              }
              if (l.type === 'COREQUISITE' && tId === currId && !allowedIds.has(sId)) {
                allowedIds.add(sId);
                pending.push(sId);
              }
            }
          });
        }

        // Also inherit program and block nodes that govern/require these allowed courses.
        // Step 1: Find Block nodes that contain prefix courses via 'BELONGS_TO'
        const programAndBlockIds = new Set<string>();
        modeLinks.forEach((l: any) => {
          const sId = typeof l.source === 'string' ? l.source : l.source.id;
          const tId = typeof l.target === 'string' ? l.target : l.target.id;
          if (l.type === 'BELONGS_TO' && prefixCourseIds.has(tId)) {
            programAndBlockIds.add(sId);
          }
        });

        // Step 2: Find Program nodes that govern those blocks via 'GOVERNS'
        modeLinks.forEach((l: any) => {
          const sId = typeof l.source === 'string' ? l.source : l.source.id;
          const tId = typeof l.target === 'string' ? l.target : l.target.id;
          if (l.type === 'GOVERNS' && programAndBlockIds.has(tId)) {
            programAndBlockIds.add(sId);
          }
        });

        // Step 3: For completeness, if a program is kept, we also pull in ALL of its blocks
        // so that any prerequisite courses (like CHM 320) that are also in this program's other blocks are correctly linked.
        const programIds = new Set<string>();
        programAndBlockIds.forEach(id => {
          if (id.startsWith('program_') || id === 'root') {
            programIds.add(id);
          }
        });

        modeLinks.forEach((l: any) => {
          const sId = typeof l.source === 'string' ? l.source : l.source.id;
          const tId = typeof l.target === 'string' ? l.target : l.target.id;
          if (l.type === 'GOVERNS' && programIds.has(sId)) {
            programAndBlockIds.add(tId);
          }
        });

        programAndBlockIds.forEach(id => allowedIds.add(id));

        modeNodes = modeNodes.filter(n => allowedIds.has(n.id) || n.group === 'faculty');
        modeLinks = modeLinks.filter((l: any) => {
          const sId = typeof l.source === 'string' ? l.source : l.source.id;
          const tId = typeof l.target === 'string' ? l.target : l.target.id;
          return allowedIds.has(sId) && allowedIds.has(tId);
        });
      }
    }

    // 3. Pre-filter by Search Query
    let searchedNodes = modeNodes;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      searchedNodes = modeNodes.filter(n =>
        (n.label && n.label.toLowerCase().includes(q)) ||
        (n.title && n.title.toLowerCase().includes(q)) ||
        (n.description && n.description.toLowerCase().includes(q))
      );
    }

    const searchNodeIds = new Set(searchedNodes.map(n => n.id));

    // 3. Apply Category filter with connected neighbor context (e.g. filtering programs shows programs + their required courses)
    if (!selectedGroup) {
      return {
        nodes: searchedNodes,
        links: modeLinks.filter((l: any) => {
          const sId = typeof l.source === 'string' ? l.source : l.source.id;
          const tId = typeof l.target === 'string' ? l.target : l.target.id;
          return searchNodeIds.has(sId) && searchNodeIds.has(tId);
        })
      };
    }

    const targetNodes = searchedNodes.filter(n => n.group === selectedGroup);
    const targetNodeIds = new Set(targetNodes.map(n => n.id));
    const connectedNodeIds = new Set<string>();

    modeLinks.forEach((l: any) => {
      const sId = typeof l.source === 'string' ? l.source : l.source.id;
      const tId = typeof l.target === 'string' ? l.target : l.target.id;

      if (targetNodeIds.has(sId) && searchNodeIds.has(tId)) connectedNodeIds.add(tId);
      if (targetNodeIds.has(tId) && searchNodeIds.has(sId)) connectedNodeIds.add(sId);
    });

    const activeNodeIds = new Set([...targetNodeIds, ...connectedNodeIds]);

    return {
      nodes: modeNodes.filter(n => activeNodeIds.has(n.id)),
      links: modeLinks.filter((l: any) => {
        const sId = typeof l.source === 'string' ? l.source : l.source.id;
        const tId = typeof l.target === 'string' ? l.target : l.target.id;
        return activeNodeIds.has(sId) && activeNodeIds.has(tId);
      })
    };
  }, [graphData, selectedGroup, searchQuery, mode, selectedNode, neighbors, selectedProgram, selectedPrefix, programsMap]);

  // Compute immediate neighbors categorized by relation types for the Inspect Sidebar
  const immediateInterconnections = useMemo(() => {
    if (!selectedNode || graphData.links.length === 0) return { prerequisites: [], governs: [], belongsTo: [], mentions: [] };

    const id = selectedNode.id;
    const prereqList: any[] = [];
    const governsList: any[] = [];
    const belongsToList: any[] = [];
    const mentionsList: any[] = [];

    graphData.links.forEach((l: any) => {
      const sId = typeof l.source === 'string' ? l.source : l.source.id;
      const tId = typeof l.target === 'string' ? l.target : l.target.id;

      if (sId === id || tId === id) {
        const neighborId = sId === id ? tId : sId;
        const neighbor = graphData.nodes.find(n => n.id === neighborId);

        if (neighbor) {
          const relation = {
            id: neighbor.id,
            label: neighbor.label,
            title: neighbor.title,
            group: neighbor.group,
            type: l.type,
            is_required: l.is_required,
            isSource: sId === id
          };

          if (l.type === 'PREREQUISITE' || l.type === 'COREQUISITE') prereqList.push(relation);
          else if (l.type === 'GOVERNS') governsList.push(relation);
          else if (l.type === 'BELONGS_TO') belongsToList.push(relation);
          else if (l.type === 'MENTIONS') mentionsList.push(relation);
        }
      }
    });

    return {
      prerequisites: prereqList,
      governs: governsList,
      belongsTo: belongsToList,
      mentions: mentionsList
    };
  }, [selectedNode, graphData]);

  if (loading) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 font-mono text-xs gap-3">
        <svg className="animate-spin h-6 w-6 text-[#8C2232]" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span>Compiling curriculum & policy coordinates...</span>
      </div>
    );
  }

  const isFadedGlobal = selectedNode !== null || hoverNode !== null || searchQuery !== '';

  return (
    <div className={`bg-[#050811] overflow-hidden transition-all ${
      isFullscreen 
        ? 'fixed inset-0 z-50 w-screen h-screen' 
        : 'absolute inset-0'
    }`}>
      {/* Canvas Viewport Area */}
      <div className="w-full h-full relative">
        
        {/* Search Bar & Category Filters (Translucent Header Control Toolbar) */}
        <div className="absolute top-6 left-6 z-30 flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`p-2 rounded-lg shadow-md border transition-all cursor-pointer flex items-center justify-center ${
                showFilters 
                  ? 'bg-[#8C2232] text-white border-[#8C2232]/50 shadow-[#8C2232]/20' 
                  : 'bg-[#0b0f1d]/90 text-slate-300 border-[#B6CFD6]/15 hover:bg-white/5'
              }`}
              title="Toggle Filter Toolbar"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>
            </button>

            {showFilters && (
              <div className="flex flex-wrap gap-2 animate-in fade-in slide-in-from-left-2 duration-200">
                {/* Text Search Input */}
                <div className="flex bg-[#0b0f1d]/95 rounded-lg shadow-md border border-[#B6CFD6]/15 px-3 py-1.5 items-center backdrop-blur-md">
                  <input
                    type="text"
                    placeholder="Search code, title, policy..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPathMode(false);
                    }}
                    className="bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none w-48 font-sans font-medium"
                    disabled={pathMode}
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="p-0.5 text-slate-400 hover:text-white cursor-pointer">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  )}
                </div>

                {/* Category Select Dropdown */}
                <select
                  value={selectedGroup}
                  onChange={(e) => setSelectedGroup(e.target.value)}
                  className="bg-[#0b0f1d]/95 border border-[#B6CFD6]/15 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-[#8C2232] cursor-pointer shadow-md backdrop-blur-md font-semibold"
                  disabled={pathMode}
                >
                  <option value="">All Categories</option>
                  <option value="course">Catalog Courses</option>
                  <option value="program">Academic Programs</option>
                  {mode === 'curriculum' && <option value="block">Requirement Blocks</option>}
                  {mode === 'curriculum' && <option value="department">Faculty / Departments</option>}
                  {mode === 'policy' && <option value="policy">Policy Chunks</option>}
                </select>

                {/* Academic Program Filter (Curriculum mode only) */}
                {mode === 'curriculum' && (
                  <select
                    value={selectedProgram}
                    onChange={(e) => {
                      setSelectedProgram(e.target.value);
                      setSelectedPrefix('');
                      setPathMode(false);
                    }}
                    className="bg-[#0b0f1d]/95 border border-[#B6CFD6]/15 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-[#8C2232] cursor-pointer shadow-md backdrop-blur-md font-semibold max-w-[150px] truncate"
                    disabled={pathMode}
                  >
                    <option value="">All Programs</option>
                    {Object.keys(programsMap).sort().map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                )}

                {/* Subject Prefix Filter (Curriculum mode only) */}
                {mode === 'curriculum' && (
                  <select
                    value={selectedPrefix}
                    onChange={(e) => {
                      setSelectedPrefix(e.target.value);
                      setSelectedProgram('');
                      setPathMode(false);
                    }}
                    className="bg-[#0b0f1d]/95 border border-[#B6CFD6]/15 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-[#8C2232] cursor-pointer shadow-md backdrop-blur-md font-semibold"
                    disabled={pathMode}
                  >
                    <option value="">All Prefixes</option>
                    {prefixesList.map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                )}

                {/* Visual Mode 2D/3D Toggle */}
                <button
                  onClick={() => setIs3D(!is3D)}
                  className={`px-3 py-1.5 rounded-lg shadow-md text-xs font-bold border transition-all cursor-pointer backdrop-blur-md font-mono ${
                    is3D 
                      ? 'bg-[#ea580c] border-[#ea580c]/50 text-white shadow-[#ea580c]/20' 
                      : 'bg-[#0b0f1d]/90 text-slate-300 border-[#B6CFD6]/15 hover:bg-white/5'
                  }`}
                >
                  {is3D ? 'WebGL 3D' : 'Canvas 2D'}
                </button>

                {/* BFS Shortest Pathfinder Mode Button (Curriculum mode only) */}
                {mode === 'curriculum' && (
                  <button
                    onClick={() => {
                      setPathMode(!pathMode);
                      setSelectedNode(null);
                    }}
                    className={`px-3 py-1.5 rounded-lg shadow-md text-xs font-bold border transition-all cursor-pointer backdrop-blur-md font-mono ${
                      pathMode 
                        ? 'bg-[#8C2232] border-[#8C2232]/50 text-white animate-pulse' 
                        : 'bg-[#0b0f1d]/90 text-slate-300 border-[#B6CFD6]/15 hover:bg-white/5'
                    }`}
                  >
                    {pathMode ? 'Exit Pathfinder' : 'Prereq Pathfinder'}
                  </button>
                )}

                {/* Fullscreen Expand Toggle */}
                <button
                  onClick={() => {
                    setIsFullscreen(!isFullscreen);
                    setTimeout(() => handleResetView(), 80);
                  }}
                  className={`p-2 rounded-lg shadow-md border transition-all cursor-pointer flex items-center justify-center ${
                    isFullscreen 
                      ? 'bg-[#8C2232] text-white border-[#8C2232]/50 shadow-[#8C2232]/20' 
                      : 'bg-[#0b0f1d]/90 text-slate-300 border-[#B6CFD6]/15 hover:bg-white/5'
                  }`}
                  title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
                >
                  {isFullscreen ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 9h6v6H9V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 9H3m2 6H3m18-6h-2m2 6h-2" /></svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
                  )}
                </button>

                {/* Reset view */}
                <button
                  onClick={handleResetView}
                  className="px-3 py-1.5 rounded-lg shadow-md text-xs font-bold border border-[#B6CFD6]/15 bg-[#0b0f1d]/90 text-slate-300 hover:text-white hover:bg-white/5 transition-all cursor-pointer backdrop-blur-md font-mono"
                >
                  Reset View
                </button>
              </div>
            )}
          </div>

          {/* Pathfinder Start/End Dropdowns */}
          {pathMode && showFilters && (
            <div className="flex gap-2 animate-in fade-in slide-in-from-left-2 duration-200 bg-[#0b0f1d]/95 p-2 rounded-lg border border-[#B6CFD6]/15 backdrop-blur-md shadow-lg w-fit">
              <select
                value={startNodeId}
                onChange={(e) => setStartNodeId(e.target.value)}
                className="bg-[#090d16] border border-[#B6CFD6]/15 rounded px-2.5 py-1 text-xs text-white outline-none max-w-[150px] font-semibold cursor-pointer"
              >
                <option value="">Start Course...</option>
                {filteredData.nodes.filter(n => n.group === 'course').map(n => (
                  <option key={n.id} value={n.id}>{n.label}</option>
                ))}
              </select>
              <span className="text-[#B6CFD6] font-bold self-center text-xs">➔</span>
              <select
                value={endNodeId}
                onChange={(e) => setEndNodeId(e.target.value)}
                className="bg-[#090d16] border border-[#B6CFD6]/15 rounded px-2.5 py-1 text-xs text-white outline-none max-w-[150px] font-semibold cursor-pointer"
              >
                <option value="">Target Course...</option>
                {filteredData.nodes.filter(n => n.group === 'course').map(n => (
                  <option key={n.id} value={n.id}>{n.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Legend Button (Translucent Bottom Left) */}
        <div className="absolute bottom-6 left-6 z-10 flex gap-2">
          <button
            onClick={() => setShowLegend(!showLegend)}
            className={`p-2 rounded-lg shadow-md border transition-all cursor-pointer flex items-center justify-center ${
              showLegend 
                ? 'bg-[#8C2232] text-white border-[#8C2232]/50 shadow-[#8C2232]/20' 
                : 'bg-[#0b0f1d]/90 text-slate-300 border-[#B6CFD6]/15 hover:bg-white/5'
            }`}
            title="Toggle Visual Legends"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          </button>

          {showLegend && (
            <div className="bg-[#0b0f1d]/90 rounded-xl shadow-lg border border-[#B6CFD6]/10 p-4 pointer-events-none w-52 animate-in fade-in slide-in-from-left-2 duration-200 backdrop-blur-md text-left space-y-4">
              {/* Nodes Legend */}
              <div>
                <h4 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider mb-2 border-b border-white/5 pb-1 font-mono">Node Legend</h4>
                <ul className="space-y-1.5 text-xs text-slate-300 font-semibold font-sans">
                  <li className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-[#8C2232] inline-block"></span> Course</li>
                  <li className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-[#f97316] inline-block"></span> Requirement Block</li>
                  {mode === 'curriculum' && (
                    <>
                      <li className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-[#eab308] inline-block"></span> Program of Study</li>
                      <li className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-[#22c55e] inline-block"></span> Department</li>
                      <li className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-[#3b82f6] inline-block"></span> Faculty</li>
                    </>
                  )}
                  {mode === 'policy' && <li className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-[#8b5cf6] inline-block"></span> Policy Narrative</li>}
                </ul>
              </div>

              {/* Edges Legend */}
              <div>
                <h4 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider mb-2 border-b border-white/5 pb-1 font-mono">Relation Legend</h4>
                <ul className="space-y-1.5 text-xs text-slate-300 font-semibold font-sans">
                  {mode === 'curriculum' && (
                    <>
                      <li className="flex items-center gap-2"><span className="w-4 h-1 rounded bg-[#8C2232] inline-block"></span> Prerequisite Path</li>
                      <li className="flex items-center gap-2"><span className="w-4 h-1 rounded bg-[#f2a900] inline-block"></span> Co-requisite Link</li>
                      <li className="flex items-center gap-2"><span className="w-4 h-1 rounded bg-[#3b82f6] inline-block"></span> Required Course Connection</li>
                      <li className="flex items-center gap-2"><span className="w-4 h-1 rounded bg-[#a855f7] inline-block"></span> Elective Course Connection</li>
                      <li className="flex items-center gap-2"><span className="w-4 h-1 rounded bg-[#eab308] inline-block"></span> Department to Program</li>
                      <li className="flex items-center gap-2"><span className="w-4 h-1 rounded bg-[#22c55e] inline-block"></span> Faculty to Department</li>
                    </>
                  )}
                  {mode === 'policy' && (
                    <>
                      <li className="flex items-center gap-2"><span className="w-4 h-1 rounded bg-[#22c55e] inline-block"></span> Program Governs</li>
                      <li className="flex items-center gap-2"><span className="w-4 h-1 rounded bg-[#f59e0b] inline-block"></span> Policy Mentions</li>
                    </>
                  )}
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Visual Graph Viewport Canvas */}
        {filteredData.nodes.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs font-mono">
            No matching coordinates mapped.
          </div>
        ) : is3D ? (
          <ForceGraph3D
            ref={fgRef}
            graphData={filteredData}
            nodeId="id"
            nodeLabel={(node: any) => `${node.group.toUpperCase()}: ${node.label} - ${node.title}`}
            onNodeClick={handleNodeClick}
            nodeVal={(node: any) => node.group === 'program' ? 6.5 : (node.group === 'subject' ? 5.5 : (node.group === 'block' ? 4.5 : (node.group === 'course' ? 3.5 : 3)))}
            nodeResolution={5}
            linkResolution={3}
            nodeColor={(node: any) => {
              if (pathMode && pathPath.size > 0) {
                if (pathPath.has(node.id)) {
                  if (node.id === startNodeId) return '#2563eb';
                  if (node.id === endNodeId) return '#dc2626';
                  return '#10b981';
                }
                return '#1e293b';
              }
              return getNodeColor(node);
            }}
            linkColor={(link: any) => {
              const sId = typeof link.source === 'string' ? link.source : link.source.id;
              const tId = typeof link.target === 'string' ? link.target : link.target.id;
              const linkKey = `${sId}-${tId}`;

              if (pathMode && pathPath.size > 0) {
                if (pathPath.has(sId) && pathPath.has(tId)) return '#10b981';
                return 'rgba(148, 163, 184, 0.09)';
              }

              if (selectedNode) {
                if (highlightLinkKeys.has(linkKey)) {
                  return getLinkColor(link, sId === selectedNode.id || tId === selectedNode.id, false);
                }
                return 'rgba(148, 163, 184, 0.09)';
              }

              return getLinkColor(link, false, isFadedGlobal);
            }}
            linkWidth={(link: any) => {
              const sId = typeof link.source === 'string' ? link.source : link.source.id;
              const tId = typeof link.target === 'string' ? link.target : link.target.id;
              const linkKey = `${sId}-${tId}`;

              if (pathMode && pathPath.size > 0) {
                if (pathPath.has(sId) && pathPath.has(tId)) return 3.0;
                return 0.5;
              }

              if (selectedNode) {
                if (sId === selectedNode.id || tId === selectedNode.id) return 3.0;
                if (highlightLinkKeys.has(linkKey)) return 1.5;
                return 0.5;
              }
              return 1.25;
            }}
            linkDirectionalArrowLength={4}
            linkDirectionalArrowRelPos={1}
            linkCurvature={0.2}
            cooldownTicks={100}
          />
        ) : (
          <ForceGraph2D
            ref={fgRef}
            graphData={filteredData}
            nodeId="id"
            nodeLabel={(node: any) => `${node.group.toUpperCase()}: ${node.label} - ${node.title}`}
            onNodeHover={(node: any) => setHoverNode(node || null)}
            onNodeClick={handleNodeClick}
            onBackgroundClick={handleBackgroundClick}
            nodeRelSize={4}
            linkHoverPrecision={6}
            linkLabel={(link: any) => {
              if (link.type === 'GOVERNS') {
                return `${link.is_required ? 'REQUIRED' : 'ELECTIVE'} FOR: ${link.source.label || 'Program'} ➔ ${link.target.label || 'Course'}`;
              }
              return `${link.type}: ${link.source.label || 'Node'} ➔ ${link.target.label || 'Node'}`;
            }}
            linkDirectionalArrowLength={4}
            linkDirectionalArrowRelPos={1}
            linkCurvature={0.25}
            nodeCanvasObject={(node: any, ctx: any, globalScale: number) => {
              const label = node.label;
              const fontSize = 11 / globalScale;
              ctx.font = `${fontSize}px sans-serif`;

              const isSelected = selectedNode?.id === node.id;
              const isPrimary = primaryNeighborIds.has(node.id);
              const isSecondary = secondaryNeighborIds.has(node.id);
              const isHovered = hoverNode?.id === node.id;
              const isHoverNeighbor = hoverNode && neighbors.get(hoverNode.id)?.has(node.id);

              let isFaded = false;
              let isPathStart = false;
              let isPathEnd = false;
              let isPathMiddle = false;

              if (pathMode) {
                if (pathPath.size > 0) {
                  if (pathPath.has(node.id)) {
                    if (node.id === startNodeId) isPathStart = true;
                    else if (node.id === endNodeId) isPathEnd = true;
                    else isPathMiddle = true;
                  } else {
                    isFaded = true;
                  }
                }
              } else if (selectedNode) {
                isFaded = !isSelected && !isPrimary && !isSecondary;
              } else if (hoverNode) {
                isFaded = !isHovered && !isHoverNeighbor;
              }

              let color = getNodeColor(node);

              if (isPathStart) color = '#2563eb';
              else if (isPathEnd) color = '#dc2626';
              else if (isPathMiddle) color = '#10b981';

              // Set alpha opacity dynamically for dimming
              ctx.globalAlpha = isFaded ? 0.12 : (isSelected || isPrimary || isHovered || isPathStart || isPathEnd ? 1.0 : 0.85);

              // 1. Draw Circle Dot
              ctx.fillStyle = color;
              ctx.beginPath();
              
              const size = node.group === 'department' ? 9.5 : (node.group === 'program' ? 7.5 : (node.group === 'block' ? 5.5 : 3.5));
              ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
              ctx.fill();

              // Selection border
              if (isSelected) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, size + 3.5 / globalScale, 0, 2 * Math.PI, false);
                ctx.strokeStyle = '#f2a900';
                ctx.lineWidth = 2 / globalScale;
                ctx.stroke();
              } else if (isPrimary) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, size + 2 / globalScale, 0, 2 * Math.PI, false);
                ctx.strokeStyle = '#B6CFD6';
                ctx.lineWidth = 1 / globalScale;
                ctx.stroke();
              } else if (isHovered) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.2 / globalScale;
                ctx.stroke();
              }

              // 2. Draw Text Label
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ctx.font = `${fontSize}px Lato, sans-serif`;
              ctx.fillStyle = isSelected ? '#ffffff' : (isFaded ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.85)');

              if (globalScale > 1.2 || isSelected || isHovered) {
                ctx.fillText(label, node.x, node.y + size + 2);
              }
            }}
            linkColor={(link: any) => {
              const sId = typeof link.source === 'string' ? link.source : link.source.id;
              const tId = typeof link.target === 'string' ? link.target : link.target.id;
              const linkKey = `${sId}-${tId}`;

              if (pathMode && pathPath.size > 0) {
                if (pathPath.has(sId) && pathPath.has(tId)) return '#10b981';
                return 'rgba(148, 163, 184, 0.09)';
              }

              if (selectedNode) {
                if (highlightLinkKeys.has(linkKey)) {
                  if (sId === selectedNode.id || tId === selectedNode.id) {
                    return getLinkColor(link, true, false);
                  }
                  return getLinkColor(link, false, false);
                }
                return 'rgba(148, 163, 184, 0.09)';
              }

              if (hoverNode && (sId === hoverNode.id || tId === hoverNode.id)) {
                return getLinkColor(link, true, false);
              }

              if (searchQuery && (searchMatchIds.has(sId) || searchMatchIds.has(tId))) {
                return getLinkColor(link, true, false);
              }

              return getLinkColor(link, false, isFadedGlobal);
            }}
            linkWidth={(link: any) => {
              const sId = typeof link.source === 'string' ? link.source : link.source.id;
              const tId = typeof link.target === 'string' ? link.target : link.target.id;
              const linkKey = `${sId}-${tId}`;

              if (pathMode && pathPath.size > 0) {
                if (pathPath.has(sId) && pathPath.has(tId)) return 3.0;
                return 0.5;
              }

              if (selectedNode) {
                if (sId === selectedNode.id || tId === selectedNode.id) return 2.5;
                if (highlightLinkKeys.has(linkKey)) return 1.5;
                return 0.5;
              }

              if (hoverNode && (sId === hoverNode.id || tId === hoverNode.id)) {
                return 2.5;
              }

              return 1.25;
            }}
            linkLineDash={(link: any) => link.type === 'COREQUISITE' ? [3, 2] : null}
            cooldownTicks={100}
          />
        )}
      </div>

      {/* Selected Element Detailed Inspect Sidebar Drawer (Right Panel) */}
      {selectedNode && (
        <div className="absolute top-0 right-0 w-full sm:w-[350px] h-full bg-[#0b0f1d]/90 border-l border-[#B6CFD6]/10 p-6 flex flex-col gap-6 text-left overflow-y-auto animate-in slide-in-from-right-4 duration-300 z-20 backdrop-blur-md shadow-2xl">
          {/* Header */}
          <div className="shrink-0 border-b border-white/5 pb-4">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                {historyStack.length > 0 && (
                  <button
                    onClick={handleBackClick}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold font-mono border bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border-white/10 cursor-pointer transition-all uppercase tracking-wider animate-in fade-in slide-in-from-left-1"
                    title="Go Back to Previous Audited Node"
                  >
                    ← Back
                  </button>
                )}
                <span className={`px-2 py-0.5 rounded font-bold text-[8px] uppercase tracking-wider font-mono border ${
                  selectedNode.group === 'course' 
                    ? 'bg-[#8C2232]/25 text-[#B6CFD6] border-[#8C2232]/45'
                    : selectedNode.group === 'block'
                      ? 'bg-orange-500/10 text-orange-400 border-orange-500/30'
                      : selectedNode.group === 'program'
                        ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30'
                        : selectedNode.group === 'department'
                          ? 'bg-green-500/10 text-green-400 border-green-500/30'
                          : selectedNode.group === 'faculty'
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                            : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30'
                }`}>
                  {selectedNode.group === 'course' 
                    ? 'Catalog Course' 
                    : selectedNode.group === 'program' 
                      ? 'Academic Program' 
                      : selectedNode.group === 'department'
                        ? 'Department'
                        : selectedNode.group === 'faculty' 
                          ? 'Faculty Member' 
                          : selectedNode.group === 'block'
                          ? 'Requirement Block'
                          : 'Policy Narrative'}
                </span>
              </div>
              <button
                onClick={() => {
                  setSelectedNode(null);
                  setHistoryStack([]);
                }}
                className="text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
            
            <h3 className="text-base font-bold serif-title text-white mt-2 leading-tight">
              {selectedNode.title}
            </h3>
            <span className="text-xs text-slate-400 font-bold font-mono tracking-wide mt-1 block">
              {selectedNode.label}
            </span>
          </div>

          {/* Details */}
          <div className="flex-1 space-y-6 text-xs overflow-y-auto">
            {/* Meta attributes */}
            {selectedNode.group === 'course' && (
              <div className="p-3 bg-white/5 rounded-xl border border-white/5 font-mono">
                <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1">Credit hours</div>
                <div className="text-sm font-bold text-white">{selectedNode.credits || '3'} Credits</div>
              </div>
            )}
            {selectedNode.group === 'program' && (
              <div className="p-3 bg-white/5 rounded-xl border border-white/5 font-mono">
                <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1">Degree classification</div>
                <div className="text-sm font-bold text-white">{selectedNode.degree_type || 'Bachelor\'s'} ({selectedNode.total_credits || '120'} Cr)</div>
              </div>
            )}
            {selectedNode.group === 'policy' && (
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 bg-white/5 rounded-xl border border-white/5 font-mono">
                  <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-0.5">Toulmin logic</div>
                  <div className="text-[10px] font-bold text-[#B6CFD6]">{selectedNode.toulmin_role || 'Warrant'}</div>
                </div>
                <div className="p-2 bg-white/5 rounded-xl border border-white/5 font-mono">
                  <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-0.5">Deontic force</div>
                  <div className="text-[10px] font-bold text-emerald-400">{selectedNode.deontic_modality || 'Obligation'}</div>
                </div>
              </div>
            )}

            {/* Description */}
            <div className="space-y-1.5 text-left">
              <div className="text-[9px] font-bold text-[#B6CFD6] uppercase tracking-widest font-mono">
                {selectedNode.group === 'block' ? 'Catalog Section Text' : 'Narrative / Description'}
              </div>
              <div className={`p-4 bg-white/5 rounded-xl border border-white/5 text-slate-300 leading-relaxed whitespace-pre-wrap ${
                selectedNode.group === 'block' || selectedNode.group === 'policy' ? 'font-mono text-[10px]' : 'font-sans font-medium'
              }`}>
                {selectedNode.description || 'No formal narrative description recorded.'}
              </div>
            </div>

            {/* Immediate Interconnections */}
            <div className="space-y-4 pt-4 border-t border-white/5 text-left">
              <h4 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Immediate Interconnections</h4>
              
              {/* Prerequisites */}
              {immediateInterconnections.prerequisites.length > 0 && (
                <div className="space-y-1.5 animate-in fade-in">
                  <div className="text-[9px] font-bold text-red-400 uppercase tracking-widest font-mono">Academic Prerequisites:</div>
                  <div className="space-y-1 border-l border-red-500/40 pl-2">
                    {immediateInterconnections.prerequisites.map((rel: any, i: number) => (
                      <button
                        key={i}
                        onClick={() => handleNeighborClick(rel.id)}
                        className="font-mono text-[10px] text-slate-300 flex items-center gap-1.5 w-full text-left hover:bg-white/5 p-1 rounded transition-all cursor-pointer"
                      >
                        <span className={`w-1 h-1 rounded-full ${rel.type === 'COREQUISITE' ? 'bg-[#f2a900]' : 'bg-red-400'}`}></span>
                        <span className="font-bold text-white hover:text-[#f2a900]">{rel.label}</span>
                        <span className="text-slate-400 truncate max-w-[180px] font-sans">({rel.title}){rel.type === 'COREQUISITE' ? ' (Co-req)' : ''}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Program Governs */}
              {immediateInterconnections.governs.length > 0 && (
                <div className="space-y-1.5 animate-in fade-in">
                  <div className="text-[9px] font-bold text-green-400 uppercase tracking-widest font-mono">Program Requirements:</div>
                  <div className="space-y-1.5 border-l border-green-500/40 pl-2">
                    {immediateInterconnections.governs.map((rel: any, i: number) => (
                      <button
                        key={i}
                        onClick={() => handleNeighborClick(rel.id)}
                        className="font-mono text-[10px] text-slate-300 flex items-center justify-between gap-1.5 w-full text-left hover:bg-white/5 p-1 rounded transition-all cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5 truncate">
                          <span className={`w-1 h-1 rounded-full ${rel.is_required ? 'bg-green-400' : 'bg-sky-400'}`}></span>
                          <span className="font-bold text-white hover:text-[#f2a900]">{rel.label}</span>
                          <span className="text-slate-400 truncate max-w-[150px] font-sans">({rel.title})</span>
                        </div>
                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider font-mono border shrink-0 ${
                          rel.is_required
                            ? 'bg-green-500/10 text-green-400 border-green-500/20'
                            : 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                        }`}>
                          {rel.is_required ? 'Required' : 'Elective'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Mentions */}
              {immediateInterconnections.mentions.length > 0 && (
                <div className="space-y-1.5 animate-in fade-in">
                  <div className="text-[9px] font-bold text-amber-400 uppercase tracking-widest font-mono">Narrative Mentions:</div>
                  <div className="space-y-1 border-l border-amber-500/40 pl-2">
                    {immediateInterconnections.mentions.map((rel: any, i: number) => (
                      <button
                        key={i}
                        onClick={() => handleNeighborClick(rel.id)}
                        className="font-mono text-[10px] text-slate-300 flex items-center gap-1.5 w-full text-left hover:bg-white/5 p-1 rounded transition-all cursor-pointer"
                      >
                        <span className="w-1 h-1 rounded-full bg-amber-400"></span>
                        <span className="font-bold text-white hover:text-[#f2a900]">{rel.label}</span>
                        <span className="text-slate-400 truncate max-w-[180px] font-sans">({rel.title})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Subject prefix */}
              {immediateInterconnections.belongsTo.length > 0 && (
                <div className="space-y-1.5 animate-in fade-in">
                  <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest font-mono">Subject Department:</div>
                  <div className="space-y-1 border-l border-slate-500/40 pl-2">
                    {immediateInterconnections.belongsTo.map((rel: any, i: number) => (
                      <button
                        key={i}
                        onClick={() => handleNeighborClick(rel.id)}
                        className="font-mono text-[10px] text-slate-300 flex items-center gap-1.5 w-full text-left hover:bg-white/5 p-1 rounded transition-all cursor-pointer"
                      >
                        <span className="w-1 h-1 rounded-full bg-slate-400"></span>
                        <span className="font-bold text-white hover:text-[#f2a900]">{rel.label}</span>
                        <span className="text-slate-400 truncate max-w-[180px] font-sans">({rel.title})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* No interconnections */}
              {immediateInterconnections.prerequisites.length === 0 &&
               immediateInterconnections.governs.length === 0 &&
               immediateInterconnections.belongsTo.length === 0 &&
               immediateInterconnections.mentions.length === 0 && (
                <div className="text-slate-500 italic p-3 font-sans text-xs">No direct neighbors mapped in this catalog context.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
