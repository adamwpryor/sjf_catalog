'use client';

import React, { useState, useEffect } from 'react';
import { INSTITUTION } from '@/lib/brand';

interface LandingPageProps {
  onTabChange: (tab: string) => void;
  catalogId: string;
}

/**
 * Renders the Landing Page component.
 *
 * @param {LandingPageProps} props - The component props.
 * @param {Function} props.onTabChange - Callback to handle tab change.
 * @param {string} props.catalogId - The ID of the catalog.
 * @returns {JSX.Element} The rendered Landing Page component.
 */
export default function LandingPage({ onTabChange, catalogId }: LandingPageProps) {
  return (
    <div className="space-y-8 animate-in fade-in duration-300 font-sans">
      {/* Visual Hero Welcome Banner */}
      <div className="relative rounded-3xl overflow-hidden glass-panel p-8 md:p-12 border border-white/5 shadow-2xl">
        {/* Glowing visual indicators */}
        <div className="absolute top-0 right-0 w-96 h-96 bg-[#8C2232]/10 rounded-full blur-[100px] -z-10 animate-pulse"></div>

        <div className="max-w-3xl space-y-6">
          <h2 className="text-4xl md:text-5xl font-extrabold serif-title text-white leading-tight">
            Academic Ingestion & <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#8C2232] via-rose-400 to-[#B6CFD6]">
              Curriculum Audit Portal
            </span>
          </h2>
          
          <p className="text-slate-400 text-sm md:text-base leading-relaxed font-medium">
            Welcome to the {INSTITUTION.legalName} catalog auditing dashboard. Explore structural course pathways, program requirements, and check catalog errors easily.
          </p>

          {/* Glowing Branded Taglines */}
          <div className="pt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs md:text-sm font-semibold uppercase tracking-widest text-[#B6CFD6] font-serif-title">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#8C2232] shadow-glow"></span>
              Browse
            </span>
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-slate-500"></span>
              Analyze
            </span>
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#B6CFD6]"></span>
              Improve
            </span>
          </div>
        </div>
      </div>

      {/* Sidebar Navigation Guide */}
      <div className="glass-panel rounded-3xl p-6 md:p-8 border border-white/5 bg-[#0b0f1d]/50">
        <h3 className="text-xl md:text-2xl font-extrabold text-white serif-title mb-2 flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-[#8C2232]"></span>
          How to Navigate the Catalog Tool
        </h3>
        <p className="text-slate-300 text-xs md:text-sm font-medium mb-6 leading-relaxed">
          Use the menu on the left side of the page to browse, view, and manage catalog information. Each section below represents a main category in the sidebar. Click on any section header or specific tool name to navigate there directly:
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 1: Overview */}
          <div className="p-5 rounded-2xl bg-white/5 border border-white/5 hover:border-[#8C2232]/40 hover:bg-[#8C2232]/5 transition-all duration-300">
            <h4 
              onClick={() => onTabChange('overview')}
              className="text-base md:text-lg font-bold text-[#B6CFD6] uppercase tracking-wider font-mono mb-2 flex items-center gap-2 cursor-pointer hover:underline hover:text-white transition-colors select-none"
            >
              📁 Overview
            </h4>
            <p className="text-xs md:text-sm text-slate-300 leading-relaxed font-medium mb-4">
              Your homepage and files. Use this to check overall metrics, chat with the AI Catalog helper, or manage raw catalog files.
            </p>
            <ul className="space-y-2">
              <li 
                onClick={() => onTabChange('overview')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Welcome</strong>
                  The homepage you are currently viewing. Use this to orient yourself and get a plain-language summary of what the catalog tools are and how to find them.
                </span>
              </li>
              <li 
                onClick={() => onTabChange('diagnostics')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Metrics</strong>
                  View key numbers like course counts, subjects, and database health statistics. Use this to audit active catalog data integrity and course distributions.
                </span>
              </li>
              <li 
                onClick={() => onTabChange('assistant')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">AI Catalog Assistant</strong>
                  Ask questions in plain English to search degrees, credits, and policies. Use this to find specific catalog details quickly without digging through PDFs.
                </span>
              </li>
              <li 
                onClick={() => onTabChange('filing_cabinet')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Intake Filing Cabinet</strong>
                  Manage and preview raw catalog files. Use this to upload catalog source PDFs so they can be processed and verified.
                </span>
              </li>
            </ul>
          </div>

          {/* Card 2: Visuals */}
          <div className="p-5 rounded-2xl bg-white/5 border border-white/5 hover:border-[#8C2232]/40 hover:bg-[#8C2232]/5 transition-all duration-300">
            <h4 
              onClick={() => onTabChange('ast_explorer')}
              className="text-base md:text-lg font-bold text-[#B6CFD6] uppercase tracking-wider font-mono mb-2 flex items-center gap-2 cursor-pointer hover:underline hover:text-white transition-colors select-none"
            >
              🎨 Visuals
            </h4>
            <p className="text-xs md:text-sm text-slate-300 leading-relaxed font-medium mb-4">
              Interactive map layouts. See how requirements, courses, and policies connect with visual flow diagrams.
            </p>
            <ul className="space-y-2">
              <li 
                onClick={() => onTabChange('ast_explorer')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Program Diagrams</strong>
                  Inspect interactive requirement maps. Use this to see how coursework blocks connect, group together, and build into a degree.
                </span>
              </li>
              <li 
                onClick={() => onTabChange('graph')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Course Graph</strong>
                  Trace prerequisite pathways. Use this to see which courses are required before taking other courses, ensuring proper course sequences.
                </span>
              </li>
              <li 
                onClick={() => onTabChange('policy_graph')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Policy Graph</strong>
                  View policy connections. Use this to see how rules are linked and how academic policies flow across the institution.
                </span>
              </li>
            </ul>
          </div>

          {/* Card 3: Data Libraries */}
          <div className="p-5 rounded-2xl bg-white/5 border border-white/5 hover:border-[#8C2232]/40 hover:bg-[#8C2232]/5 transition-all duration-300">
            <h4 
              onClick={() => onTabChange('courses')}
              className="text-base md:text-lg font-bold text-[#B6CFD6] uppercase tracking-wider font-mono mb-2 flex items-center gap-2 cursor-pointer hover:underline hover:text-white transition-colors select-none"
            >
              📖 Data Libraries
            </h4>
            <p className="text-xs md:text-sm text-slate-300 leading-relaxed font-medium mb-3">
              Official records. Search, filter, and browse all details of courses, programs, and policies in a spreadsheet view.
            </p>
            <ul className="space-y-2">
              <li 
                onClick={() => onTabChange('courses')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Course Library</strong>
                  Search, filter, and inspect course details. Use this to verify course credit hours, descriptions, and prerequisites in a spreadsheet table.
                </span>
              </li>
              <li 
                onClick={() => onTabChange('programs')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Program Library</strong>
                  Browse program requirements and degree details. Use this to review and verify degree program structures and required credit hours.
                </span>
              </li>
              <li 
                onClick={() => onTabChange('policies')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Policy Library</strong>
                  Read official policies and rules. Use this to review catalog sections, regulations, and academic policy paragraphs.
                </span>
              </li>
            </ul>
          </div>

          {/* Card 4: Catalog Tools */}
          <div className="p-5 rounded-2xl bg-white/5 border border-white/5 hover:border-[#8C2232]/40 hover:bg-[#8C2232]/5 transition-all duration-300">
            <h4 
              onClick={() => onTabChange('diff_log')}
              className="text-base md:text-lg font-bold text-[#B6CFD6] uppercase tracking-wider font-mono mb-2 flex items-center gap-2 cursor-pointer hover:underline hover:text-white transition-colors select-none"
            >
              ⚙️ Catalog Tools
            </h4>
            <p className="text-xs md:text-sm text-slate-300 leading-relaxed font-medium mb-3">
              Catalog editor and publisher. Check edits, compare versions, and publish catalog releases.
            </p>
            <ul className="space-y-2">
              <li 
                onClick={() => onTabChange('diff_log')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Diff Log</strong>
                  Compare different catalog versions. Use this to audit exactly what was added, removed, or modified between draft and published catalogs.
                </span>
              </li>
              <li
                onClick={() => onTabChange('produce')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Catalog Production</strong>
                  Draft and publish catalogs. Use this to copy catalog data to start new drafts, or push finalized drafts to production.
                </span>
              </li>
              <li
                onClick={() => onTabChange('tracking')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">New Catalog Builder</strong>
                  Edit course fields and process minutes. Use this to log overrides manually or use AI to extract corrections from curriculum meeting minutes.
                </span>
              </li>
              <li
                onClick={() => onTabChange('catalog_pdf')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Catalog PDF</strong>
                  Generate and view a PDF of any catalog. Use this to preview a provisional PDF of a draft before publishing, or download the published catalog-of-record.
                </span>
              </li>
              <li
                onClick={() => onTabChange('improvement')}
                className="group/item flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/5 transition-all cursor-pointer text-slate-300 hover:text-white"
              >
                <svg className="w-4 h-4 text-[#B6CFD6] group-hover/item:text-white transition-colors mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
                <span className="text-xs md:text-sm font-medium">
                  <strong className="text-white group-hover/item:underline block">Catalog Improvement Plan</strong>
                  View automatically detected catalog issues. Use this to check which errors have been fixed and which are still active.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
