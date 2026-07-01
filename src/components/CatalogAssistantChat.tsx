'use client';

import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Message {
  sender: 'user' | 'assistant';
  text: string;
  sources?: { title: string; content: string }[];
  vectorSearch?: boolean;
  terminalLogs?: { query: string; result: string; timestamp: string }[];
}

interface CatalogAssistantChatProps {
  catalogId: string;
}

// Premium high-fidelity Markdown-to-HTML parser for Word/PDF chat exports
/**
 * Formats Markdown to HTML for export.
 *
 * @param {string} markdown - The markdown content.
 * @returns {string} The parsed HTML string.
 */
function formatMarkdownToHTML(markdown: string): string {
  if (!markdown) return '';

  const lines = markdown.split('\n');
  let inList = false;
  let listType: 'ul' | 'ol' | null = null;
  const htmlOutput: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const isUlItem = line.startsWith('* ') || line.startsWith('- ');
    const isOlItem = /^\d+\.\s+/.test(line);

    if (inList && !isUlItem && !isOlItem) {
      htmlOutput.push(listType === 'ul' ? '</ul>' : '</ol>');
      inList = false;
      listType = null;
    }

    if (!line) {
      if (!inList) {
        htmlOutput.push('<br>');
      }
      continue;
    }

    // Handle Headings
    if (line.startsWith('# ')) {
      const text = line.substring(2);
      htmlOutput.push(`<h1 style="color: #8C2232; font-family: Georgia, serif; font-size: 15pt; margin-top: 20px; margin-bottom: 8px; border-bottom: 1px solid #E2E8F0; padding-bottom: 4px;">${text}</h1>`);
    } else if (line.startsWith('## ')) {
      const text = line.substring(3);
      htmlOutput.push(`<h2 style="color: #8C2232; font-family: Georgia, serif; font-size: 13pt; margin-top: 16px; margin-bottom: 6px;">${text}</h2>`);
    } else if (line.startsWith('### ')) {
      const text = line.substring(4);
      htmlOutput.push(`<h3 style="color: #8C2232; font-family: Georgia, serif; font-size: 11pt; margin-top: 12px; margin-bottom: 4px;">${text}</h3>`);
    }
    // Handle List Items
    else if (isUlItem) {
      const text = line.substring(2);
      if (!inList) {
        htmlOutput.push('<ul style="margin-top: 4px; margin-bottom: 8px; padding-left: 20px; font-family: Arial, sans-serif; color: #334155;">');
        inList = true;
        listType = 'ul';
      }
      htmlOutput.push(`<li style="margin-bottom: 3px; line-height: 1.5;">${text}</li>`);
    } else if (isOlItem) {
      const text = line.replace(/^\d+\.\s+/, '');
      if (!inList) {
        htmlOutput.push('<ol style="margin-top: 4px; margin-bottom: 8px; padding-left: 20px; font-family: Arial, sans-serif; color: #334155;">');
        inList = true;
        listType = 'ol';
      }
      htmlOutput.push(`<li style="margin-bottom: 3px; line-height: 1.5;">${text}</li>`);
    }
    // Handle Standard Paragraphs
    else {
      htmlOutput.push(`<p style="margin-top: 0; margin-bottom: 8px; line-height: 1.5; color: #334155; font-family: Arial, sans-serif;">${line}</p>`);
    }
  }

  if (inList) {
    htmlOutput.push(listType === 'ul' ? '</ul>' : '</ol>');
  }

  let finalHtml = htmlOutput.join('\n');
  finalHtml = finalHtml
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color: #0F172A;">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em style="color: #475569;">$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background-color: #F1F5F9; color: #0F172A; padding: 2px 4px; border-radius: 4px; font-family: monospace; font-size: 9pt;">$1</code>');

  return finalHtml;
}

// Collapsible Terminal Logs Component
/**
 * Component to display collapsible terminal logs.
 *
 * @param {Object} props - The component props.
 * @param {Array} props.logs - The terminal logs array.
 * @returns {JSX.Element} The terminal logs drawer component.
 */
function TerminalLogsDrawer({ logs }: { logs: { query: string; result: string; timestamp: string }[] }) {
  const [isOpen, setIsOpen] = useState(false);
  
  return (
    <div className="mt-3 w-full border border-[#B6CFD6]/15 rounded-xl overflow-hidden bg-[#070b13] transition-all">
      <button 
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-[10px] font-bold font-mono tracking-wider uppercase text-[#B6CFD6] hover:bg-white/5 transition-all cursor-pointer border-none bg-transparent"
      >
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
          <span>Agent SQL & Tool Logs ({logs.length} Calls)</span>
        </div>
        <span className="text-[9px]">{isOpen ? 'COLLAPSE ▲' : 'EXPAND LOGS ▼'}</span>
      </button>
      {isOpen && (
        <div className="p-3.5 bg-black/45 border-t border-[#B6CFD6]/10 font-mono text-[9px] text-[#A6C0CA] space-y-2 max-h-60 overflow-y-auto leading-normal">
          {logs.map((log, idx) => (
            <div key={idx} className="border-b border-white/5 pb-2 last:border-0 last:pb-0">
              <div className="flex justify-between items-center text-[#B6CFD6]/40 mb-1 text-[8px]">
                <span>TURN {idx + 1} | {new Date(log.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="text-emerald-400 font-bold mb-0.5 select-all">&gt; {log.query}</div>
              <pre className="bg-[#0b0f1d]/80 p-2 rounded border border-white/5 overflow-x-auto max-w-full text-slate-300 select-all whitespace-pre-wrap font-mono text-[8px]">
                {log.result}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Renders the AI catalog assistant chat interface.
 *
 * @param {CatalogAssistantChatProps} props - The component properties.
 * @returns {JSX.Element} The chat interface component.
 */
export default function CatalogAssistantChat({ catalogId }: CatalogAssistantChatProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      sender: 'assistant',
      text: "Hello! I am your AI Catalog Assistant. I am here to help you search, explore, and audit academic catalog information.\n\nYou can switch between two modes depending on your questions:\n\n* **Strict RAG Mode**: Best for looking up official course descriptions, catalog sections, and academic policies (e.g., *\"What is the probation policy?\"*).\n* **General Reasoning Mode**: Best for analyzing connections, course prerequisite paths, and running database queries (e.g., *\"What courses require ACCT 110?\"*).\n\nFeel free to ask a question in either mode, or switch between them as needed. How can I help you today?"
    }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'RAG' | 'GENERAL'>('RAG');
  const [selectedModel, setSelectedModel] = useState('gemini-3.1-flash');
  const [selectedSource, setSelectedSource] = useState<{ title: string; content: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const models = [
    { value: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash (Recommended)', provider: 'Gemini' },
    { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro (Analytical)', provider: 'Gemini' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Gemini' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Gemini' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', provider: 'Gemini' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', provider: 'Gemini' },
    { value: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet', provider: 'Anthropic' },
    { value: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku', provider: 'Anthropic' },
    { value: 'claude-3-opus-latest', label: 'Claude 3 Opus', provider: 'Anthropic' },
    { value: 'gpt-4o', label: 'ChatGPT GPT-4o', provider: 'OpenAI' },
    { value: 'gpt-4o-mini', label: 'ChatGPT GPT-4o Mini', provider: 'OpenAI' }
  ];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleExportChat = (format: 'txt' | 'md') => {
    try {
      const outputLines: string[] = [];
      messages.forEach((msg) => {
        const roleLabel = msg.sender === 'user' ? 'You' : 'Catalog Assistant';
        outputLines.push(`**${roleLabel}**:\n${msg.text}\n`);
      });
      const contentText = outputLines.join('\n');
      const blob = new Blob([contentText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ccsj_catalog_assistant_chat_${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert('Failed to export chat.');
    }
  };

  const handleExportWord = () => {
    try {
      const outputLines: string[] = [];
      messages.forEach((msg) => {
        const roleLabel = msg.sender === 'user' ? 'You' : 'Catalog Assistant';
        const formattedBody = formatMarkdownToHTML(msg.text);
        
        let sourcesText = '';
        if (msg.sources && msg.sources.length > 0) {
          sourcesText = `
            <div style="font-size: 8.5pt; color: #64748B; font-family: 'Courier New', monospace; margin-top: 6px; padding-left: 10px; border-left: 2px solid #CBD5E1;">
              <strong>Sources Cited:</strong> ${msg.sources.join(', ')}
            </div>
          `;
        }

        let logsText = '';
        if (msg.terminalLogs && msg.terminalLogs.length > 0) {
          const logLines = msg.terminalLogs.map((l, i) => `
            <div style="margin-bottom: 6px; border-bottom: 1px dashed #E2E8F0; padding-bottom: 4px;">
              <span style="color: #64748B; font-size: 7.5pt;">TURN ${i + 1} | ${l.timestamp}</span><br>
              <strong style="color: #059669; font-size: 8pt;">&gt; ${l.query}</strong><br>
              <pre style="background-color: #F8FAFC; color: #334155; padding: 6px; border: 1px solid #E2E8F0; border-radius: 4px; font-size: 7.5pt; margin-top: 2px; overflow-x: auto; white-space: pre-wrap; font-family: 'Courier New', monospace;">${l.result}</pre>
            </div>
          `).join('');
          
          logsText = `
            <div style="margin-top: 10px; padding: 10px; background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; font-family: sans-serif;">
              <div style="font-size: 8.5pt; font-weight: bold; color: #0F172A; margin-bottom: 6px;">Developer & Database SQL Audit Logs</div>
              ${logLines}
            </div>
          `;
        }

        outputLines.push(`
          <div style="margin-bottom: 25px; page-break-inside: avoid; border-bottom: 1px solid #F1F5F9; padding-bottom: 15px;">
            <p style="font-weight: bold; color: ${msg.sender === 'user' ? '#8C2232' : '#0F172A'}; font-size: 11pt; margin-bottom: 6px; font-family: 'Arial', sans-serif; text-transform: uppercase; letter-spacing: 0.5px;">
              ${roleLabel}
            </p>
            <div style="font-size: 11pt; color: #334155; font-family: 'Arial', sans-serif;">
              ${formattedBody}
            </div>
            ${sourcesText}
            ${logsText}
          </div>
        `);
      });

      const htmlContent = `
        <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
        <head>
          <meta charset="utf-8">
          <!--[if gte mso 9]>
          <xml>
            <w:WordDocument>
              <w:View>Print</w:View>
              <w:Zoom>90</w:Zoom>
            </w:WordDocument>
          </xml>
          <![endif]-->
          <style>
            body { font-family: 'Arial', sans-serif; font-size: 11pt; color: #333333; line-height: 1.5; margin: 1in; }
            h2 { color: #8C2232; font-family: 'Georgia', serif; font-size: 18pt; margin-bottom: 5px; }
            .meta { font-size: 9pt; color: #666666; font-family: 'Courier New', monospace; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <h2>Calumet College of Saint Joseph</h2>
          <div style="font-size: 12pt; font-weight: bold; color: #555555; margin-bottom: 5px;">AI Catalog Assistant Executive Audit Transcript</div>
          <div class="meta">Date: ${new Date().toLocaleDateString()} | Catalog: ${catalogId}</div>
          <hr style="border:0;border-top:2px solid #8C2232;margin-bottom:25px;">
          ${outputLines.join('')}
        </body>
        </html>
      `;

      const blob = new Blob([htmlContent], { type: 'application/msword;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ccsj_catalog_assistant_chat_${new Date().toISOString().slice(0, 10)}.doc`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert('Failed to export to Word.');
    }
  };

  const handleExportPDF = () => {
    try {
      const printWindow = window.open('', '_blank');
      if (!printWindow) {
        alert('Please allow popups to export to PDF.');
        return;
      }

      const outputLines: string[] = [];
      messages.forEach((msg) => {
        const roleLabel = msg.sender === 'user' ? 'You' : 'Catalog Assistant';
        const formattedBody = formatMarkdownToHTML(msg.text);

        let sourcesText = '';
        if (msg.sources && msg.sources.length > 0) {
          sourcesText = `
            <div style="font-size: 8.5pt; color: #475569; font-family: monospace; margin-top: 6px; padding-left: 10px; border-left: 2px solid #94A3B8;">
              <strong>Sources Cited:</strong> ${msg.sources.join(', ')}
            </div>
          `;
        }

        let logsText = '';
        if (msg.terminalLogs && msg.terminalLogs.length > 0) {
          const logLines = msg.terminalLogs.map((l, i) => `
            <div style="margin-bottom: 6px; border-bottom: 1px dashed #E2E8F0; padding-bottom: 4px;">
              <span style="color: #64748B; font-size: 7.5pt;">TURN ${i + 1} | ${l.timestamp}</span><br>
              <strong style="color: #059669; font-size: 8pt;">&gt; ${l.query}</strong><br>
              <pre style="background-color: #F8FAFC; color: #334155; padding: 6px; border: 1px solid #E2E8F0; border-radius: 4px; font-size: 7.5pt; margin-top: 2px; overflow-x: auto; white-space: pre-wrap; font-family: monospace;">${l.result}</pre>
            </div>
          `).join('');
          
          logsText = `
            <div style="margin-top: 10px; padding: 10px; background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; font-family: sans-serif;">
              <div style="font-size: 8.5pt; font-weight: bold; color: #0F172A; margin-bottom: 6px;">Developer & Database SQL Audit Logs</div>
              ${logLines}
            </div>
          `;
        }

        outputLines.push(`
          <div style="margin-bottom: 25px; page-break-inside: avoid; border-bottom: 1px solid #E2E8F0; padding-bottom: 15px;">
            <div style="font-weight: bold; color: ${msg.sender === 'user' ? '#8C2232' : '#0F172A'}; font-size: 10pt; text-transform: uppercase; margin-bottom: 6px; font-family: sans-serif; letter-spacing: 0.5px;">
              ${roleLabel}
            </div>
            <div style="font-size: 11pt; line-height: 1.6; color: #334155; font-family: sans-serif;">
              ${formattedBody}
            </div>
            ${sourcesText}
            ${logsText}
          </div>
        `);
      });

      printWindow.document.write(`
        <html>
        <head>
          <title>AI Catalog Assistant Chat Export</title>
          <style>
            body { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 40px; color: #334155; }
            h1 { font-family: Georgia, serif; color: #8C2232; font-size: 20pt; margin-bottom: 5px; }
            .header { border-bottom: 3px solid #8C2232; padding-bottom: 15px; margin-bottom: 30px; }
            .meta { font-size: 9pt; color: #64748B; font-family: monospace; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>Calumet College of Saint Joseph</h1>
            <div style="font-size: 11pt; font-weight: bold; color: #475569; margin-top:2px;">AI Catalog Assistant Executive Audit Transcript</div>
            <div class="meta">Date: ${new Date().toLocaleDateString()} | Catalog: ${catalogId}</div>
          </div>
          ${outputLines.join('')}
          <script>
            window.onload = function() {
              window.print();
              setTimeout(function() { window.close(); }, 500);
            };
          </script>
        </body>
        </html>
      `);
      printWindow.document.close();
    } catch (err) {
      console.error(err);
      alert('Failed to export to PDF.');
    }
  };

  const sendMessage = async (textToSend: string) => {
    if (!textToSend.trim() || loading || !catalogId) return;

    setInput('');
    setMessages(prev => [...prev, { sender: 'user', text: textToSend }]);
    setLoading(true);

    try {
      // Build previous chat history payload for contextual memory
      const chatHistory = messages.slice(1).map(m => ({
        role: m.sender === 'user' ? 'user' : 'assistant',
        content: m.text
      }));

      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: textToSend, 
          catalogId,
          modelId: selectedModel,
          mode: mode,
          history: chatHistory
        })
      });

      if (res.ok) {
        const data = await res.json();
        setMessages(prev => [...prev, {
          sender: 'assistant',
          text: data.response,
          sources: data.sources,
          vectorSearch: data.vectorSearch,
          terminalLogs: data.terminalLogs
        }]);
      } else {
        const data = await res.json();
        setMessages(prev => [...prev, {
          sender: 'assistant',
          text: `⚠️ **Failed to complete generation:** ${data.error || 'Server error.'}`
        }]);
      }
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, {
        sender: 'assistant',
        text: "⚠️ **Connection failure:** Failed to reach the assistant API boundary."
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] animate-in fade-in duration-300 font-sans">
      
      {/* Configuration Header & Exporter Bar */}
      <div className="bg-[#0b0f1d] p-4 rounded-xl border border-[#B6CFD6]/10 mb-4 shrink-0 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between text-left">
        <div>
          <h2 className="text-lg font-bold text-white serif-title">AI Catalog Assistant</h2>
          <p className="text-xs text-slate-400 font-medium">Verify you have selected the correct Catalog Version above before running audits.</p>
        </div>

        {/* Exporter Dropdown */}
        <div className="relative group self-stretch md:self-auto flex">
          <button 
            type="button"
            className="w-full md:w-auto text-xs bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 px-3.5 py-2 rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer font-semibold"
            title="Export chat history"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
            </svg>
            <span>Export Chat ▾</span>
          </button>
          <div className="absolute right-0 pt-2 w-full md:w-40 hidden group-hover:block z-20">
            <div className="bg-[#0b0f1d] rounded-lg shadow-xl border border-[#B6CFD6]/15 overflow-hidden">
              <button 
                type="button" 
                onClick={() => handleExportChat('txt')} 
                className="w-full text-left px-4 py-2.5 text-xs text-slate-300 hover:bg-[#8C2232] hover:text-white cursor-pointer transition-colors border-none bg-transparent"
              >
                Plain Text (.txt)
              </button>
              <button 
                type="button" 
                onClick={() => handleExportChat('md')} 
                className="w-full text-left px-4 py-2.5 text-xs text-slate-300 hover:bg-[#8C2232] hover:text-white cursor-pointer transition-colors border-none bg-transparent"
              >
                Markdown (.md)
              </button>
              <button 
                type="button" 
                onClick={handleExportWord} 
                className="w-full text-left px-4 py-2.5 text-xs text-slate-300 hover:bg-[#8C2232] hover:text-white cursor-pointer transition-colors border-none bg-transparent"
              >
                Word (.docx)
              </button>
              <button 
                type="button" 
                onClick={handleExportPDF} 
                className="w-full text-left px-4 py-2.5 text-xs text-slate-300 hover:bg-[#8C2232] hover:text-white cursor-pointer transition-colors border-none bg-transparent"
              >
                PDF (.pdf)
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Cognitive Configuration Controls Drawer */}
      <div className={`p-4 rounded-xl border mb-4 shrink-0 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between text-left transition-all ${
        mode === 'RAG' 
          ? 'bg-[#0b0f1d]/50 border-[#B6CFD6]/10' 
          : 'bg-[#062419]/35 border-emerald-500/20'
      }`}>
        
        {/* Mode Radio Toggles */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Assistant Mode:</span>
          <div className="flex bg-black/45 border border-white/5 rounded-lg p-0.5 mr-2">
            <button
              type="button"
              onClick={() => setMode('RAG')}
              className={`px-3 py-1.5 rounded-md text-[9px] font-bold uppercase tracking-wider transition-all cursor-pointer border-none ${
                mode === 'RAG'
                  ? 'bg-[#8C2232] text-white shadow-md'
                  : 'text-slate-400 hover:text-white bg-transparent'
              }`}
            >
              Strict RAG
            </button>
            <button
              type="button"
              onClick={() => setMode('GENERAL')}
              className={`px-3 py-1.5 rounded-md text-[9px] font-bold uppercase tracking-wider transition-all cursor-pointer border-none ${
                mode === 'GENERAL'
                  ? 'bg-[#10b981] text-white shadow-md shadow-emerald-500/10'
                  : 'text-slate-400 hover:text-white bg-transparent'
              }`}
            >
              General Reasoning
            </button>
          </div>

          {/* Large Glowing Status Badges */}
          {mode === 'RAG' ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[8px] font-extrabold bg-[#8C2232]/25 text-[#B6CFD6] border border-[#8C2232]/45 font-mono uppercase tracking-wider animate-in fade-in duration-200">
              <span className="w-1.5 h-1.5 rounded-full bg-[#8C2232]"></span>
              Document RAG Active
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[8px] font-extrabold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 font-mono uppercase tracking-wider animate-in fade-in duration-200 animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              SQL Agent Active
            </span>
          )}
        </div>

        {/* Model Selection Dropdown */}
        <div className="flex items-center gap-3 w-full md:w-auto">
          <span className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Cognitive Model:</span>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="flex-1 md:flex-initial bg-black/45 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-[#8C2232] transition-all font-semibold cursor-pointer"
          >
            {models.map((m) => (
              <option key={m.value} value={m.value} className="bg-[#0b0f1d] text-slate-200">
                [{m.provider}] {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Chat Messages Logs Panel */}
      <div className={`flex-1 overflow-y-auto p-6 rounded-2xl border space-y-4 mb-4 relative transition-all duration-300 ${
        mode === 'RAG' 
          ? 'bg-[#0b0f1d] border-[#B6CFD6]/10 shadow-inner' 
          : 'bg-[#080d16] border-emerald-500/10 shadow-lg shadow-emerald-500/5'
      }`}>
        
        {/* Floating Active Banner Indicator */}
        <div className="absolute top-4 right-6 z-10 hidden md:block">
          {mode === 'RAG' ? (
            <div className="bg-[#0b0f1d] px-3.5 py-1.5 rounded-xl border border-[#B6CFD6]/10 text-[9px] font-mono font-bold text-slate-400 tracking-wider shadow-lg flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#8C2232]"></span>
              <span>GATEWAY: STRICT DOCUMENT GROUNDING (RAG)</span>
            </div>
          ) : (
            <div className="bg-[#061e15] px-3.5 py-1.5 rounded-xl border border-emerald-500/20 text-[9px] font-mono font-bold text-emerald-400 tracking-wider shadow-lg flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
              <span>GATEWAY: MULTI-HOP GRAPH & SQL AGENT (TOOLS)</span>
            </div>
          )}
        </div>

        {messages.map((msg, idx) => {
          const isUser = msg.sender === 'user';
          return (
            <div
              key={idx}
              className={`flex flex-col max-w-[85%] ${isUser ? 'ml-auto items-end' : 'mr-auto items-start'}`}
            >
              {/* Message Bubble box */}
              <div className={`p-4 rounded-2xl border text-xs leading-relaxed font-medium text-left ${
                isUser 
                  ? 'bg-[#8C2232] text-white border-[#8C2232]/50 rounded-br-none shadow-md shadow-[#8C2232]/10'
                  : 'bg-white/5 text-slate-200 border-white/5 rounded-bl-none'
              }`}>
                <div className="markdown-content">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({node, ...props}) => <h1 className="text-sm font-extrabold mt-4 mb-2 text-white border-b border-[#B6CFD6]/10 pb-1" {...props} />,
                      h2: ({node, ...props}) => <h2 className="text-xs font-bold mt-3 mb-1.5 text-white" {...props} />,
                      p: ({node, ...props}) => <p className="mb-2 last:mb-0 leading-relaxed text-slate-300" {...props} />,
                      ul: ({node, ...props}) => <ul className="list-disc ml-4 mb-2 space-y-1 block" {...props} />,
                      li: ({node, ...props}) => <li className="pl-0.5 text-slate-300" {...props} />,
                      strong: ({node, ...props}) => <strong className="font-bold text-white" {...props} />
                    }}
                  >
                    {msg.text}
                  </ReactMarkdown>
                </div>
              </div>

              {/* RAG / Agent metadata badges */}
              {!isUser && (
                <div className="mt-2 flex flex-col gap-1.5 text-[9px] font-mono text-slate-500 text-left w-full pl-2">
                  <div className="flex items-center gap-1.5 font-bold uppercase tracking-widest text-[#B6CFD6]/50">
                    <span className={`w-1.5 h-1.5 rounded-full ${msg.vectorSearch !== undefined ? (msg.vectorSearch ? 'bg-emerald-400' : 'bg-[#8C2232]') : 'bg-[#B6CFD6]/50'}`}></span>
                    <span>
                      {msg.vectorSearch !== undefined 
                        ? (msg.vectorSearch ? 'pgvector RAG Retrieval' : 'General Reasoning Agent')
                        : 'Default Welcome'}
                    </span>
                  </div>
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-0.5">
                      {msg.sources.map((src, i) => {
                        const title = typeof src === 'string' ? src : src.title;
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => setSelectedSource(typeof src === 'string' ? { title: src, content: 'No content detail parsed.' } : src)}
                            className="px-2 py-0.5 rounded bg-white/5 border border-white/10 hover:bg-white/10 hover:border-[#B6CFD6]/35 text-slate-400 hover:text-white transition-all truncate max-w-[180px] cursor-pointer flex items-center gap-1 font-mono text-[9px] text-left"
                            title="Click to view cited catalog content"
                          >
                            <span>📄</span>
                            <span className="truncate">{title}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {msg.terminalLogs && msg.terminalLogs.length > 0 && (
                    <TerminalLogsDrawer logs={msg.terminalLogs} />
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Loading Indicator */}
        {loading && (
          <div className="mr-auto items-start flex flex-col max-w-[80%] animate-pulse">
            <div className="p-4 rounded-2xl border bg-white/5 border-white/5 rounded-bl-none text-xs text-slate-400 flex items-center gap-2">
              <svg className="animate-spin h-3.5 w-3.5 text-[#B6CFD6]" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>
                {mode === 'RAG' 
                  ? 'Searching institutional vector indexes...' 
                  : 'Agent evaluating multi-hop pathways...'}
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Message Form */}
      <form onSubmit={handleSend} className="flex gap-3 shrink-0 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
          rows={5}
          placeholder={mode === 'RAG' ? "Ask about academic policies (e.g. 'probation requirements')" : "Ask about dependencies (e.g. 'prerequisites for ACCT 211')"}
          className={`flex-1 bg-[#0b0f1d] border rounded-xl px-5 py-3 text-xs text-white placeholder-slate-500 outline-none transition-all disabled:opacity-50 resize-none overflow-y-auto min-h-[96px] max-h-[150px] ${
            mode === 'RAG' 
              ? 'border-[#B6CFD6]/15 focus:border-[#8C2232] focus:ring-1 focus:ring-[#8C2232]' 
              : 'border-emerald-500/20 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500'
          }`}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className={`text-white rounded-xl px-6 font-semibold text-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 border-none shrink-0 h-[46px] self-end ${
            mode === 'RAG'
              ? 'bg-[#8C2232] hover:bg-[#65121e] active:scale-[0.98] shadow-lg hover:shadow-[#8C2232]/25'
              : 'bg-[#059669] hover:bg-[#047857] active:scale-[0.98] shadow-lg hover:shadow-emerald-600/25'
          }`}
        >
          <span>Ask Assistant</span>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </form>

      {/* Source Reference Modal */}
      {selectedSource && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0b0f1d] border border-[#B6CFD6]/30 rounded-xl w-full max-w-2xl flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-white/10 bg-black/50 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2 text-[#B6CFD6]">
                <svg className="w-5 h-5 text-[#B6CFD6]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                <h3 className="text-sm font-bold text-white uppercase tracking-wide">Cited Source Content</h3>
              </div>
              <button onClick={() => setSelectedSource(null)} className="text-slate-500 hover:text-white transition-colors cursor-pointer text-lg">✕</button>
            </div>
            <div className="p-6 max-h-[60vh] overflow-y-auto custom-scrollbar font-sans text-xs">
              <h4 className="text-sm font-bold text-white mb-3 font-mono">
                {selectedSource.title}
              </h4>
              <div className="border border-white/5 rounded-xl p-4 bg-black/15 text-slate-300 whitespace-pre-wrap leading-relaxed">
                {selectedSource.content || 'No detailed content available.'}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-white/10 bg-black/50 flex justify-end gap-3 shrink-0">
              <button onClick={() => setSelectedSource(null)} className="px-5 py-2 bg-[#8C2232] hover:bg-[#65121e] text-white rounded-lg text-xs font-bold transition-all cursor-pointer">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
