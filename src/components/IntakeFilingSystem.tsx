'use client';

import React, { useState, useEffect, useRef } from 'react';

/**
 * IntakeFilingSystem Component
 * Renders a "Filing Cabinet" GUI to view and manage ingested files.
 */
export default function IntakeFilingSystem() {
  const [structure, setStructure] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPath, setCurrentPath] = useState<string>(''); // empty means root
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [uploading, setUploading] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchFiles = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/intake-files');
      if (res.ok) {
        const { data } = await res.json();
        setStructure(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  // Helper to find current folder's children recursively
  const getCurrentFolderContent = () => {
    if (!currentPath) return structure;
    const parts = currentPath.split('/');
    let current = structure;
    for (const part of parts) {
      const folder = current.find((item: any) => item.name === part && item.type === 'folder');
      if (folder) {
        current = folder.children || [];
      } else {
        return [];
      }
    }
    return current;
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      const res = await fetch('/api/intake-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_folder',
          payload: { parentPath: currentPath, folderName: newFolderName.trim() }
        })
      });
      if (res.ok) {
        setNewFolderName('');
        setShowCreateFolder(false);
        fetchFiles();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to create folder');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      Array.from(e.target.files).forEach(file => {
        formData.append('file', file);
      });
      formData.append('targetFolder', currentPath);

      const res = await fetch('/api/intake-files', {
        method: 'POST',
        body: formData
      });

      if (res.ok) {
        fetchFiles();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to upload files');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (targetPath: string) => {
    if (!confirm(`Are you sure you want to delete ${targetPath}?`)) return;
    try {
      const res = await fetch('/api/intake-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          payload: { targetPath }
        })
      });
      if (res.ok) {
        fetchFiles();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to delete');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const content = getCurrentFolderContent();

  return (
    <div className="bg-[#0b0f1d] p-6 rounded-xl border border-white/10 flex flex-col h-full space-y-4">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-white/5 pb-4">
        <div>
          <h2 className="text-xl font-bold text-white serif-title flex items-center gap-2">
            <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" /></svg>
            Intake Filing Cabinet
          </h2>
          <p className="text-xs text-slate-400 mt-1">Manage, upload, and organize curriculum committee minutes before AI extraction.</p>
        </div>
        
        <div className="flex gap-3">
          <button
            onClick={() => setShowCreateFolder(!showCreateFolder)}
            className="px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-bold text-white transition-all flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
            New Folder
          </button>
          <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept=".docx,.pdf,.md,.txt" multiple />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="px-4 py-2 bg-[#8C2232] hover:bg-[#65121e] border border-[#8C2232]/50 rounded-lg text-xs font-bold text-white transition-all shadow-lg flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            {uploading ? 'Uploading...' : 'Upload File'}
          </button>
        </div>
      </div>

      {showCreateFolder && (
        <div className="bg-black/30 p-4 rounded-lg border border-white/10 flex gap-3 animate-in slide-in-from-top-2">
          <input
            type="text"
            placeholder="Folder name"
            className="flex-1 bg-[#090d16] border border-white/20 rounded px-3 py-2 text-sm text-white outline-none focus:border-[#8C2232]"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
          />
          <button onClick={handleCreateFolder} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded transition-all">Create</button>
        </div>
      )}

      {/* Breadcrumb Navigation */}
      <div className="flex items-center gap-2 text-xs font-mono bg-black/50 p-2 rounded border border-white/5">
        {currentPath !== '' && (
          <button 
            onClick={() => {
              const parts = currentPath.split('/').filter(Boolean);
              parts.pop();
              setCurrentPath(parts.join('/'));
            }} 
            className="flex items-center justify-center p-1 bg-white/10 hover:bg-white/20 rounded mr-2 transition-colors"
            title="Go up one folder"
          >
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
          </button>
        )}
        <button onClick={() => setCurrentPath('')} className="text-blue-400 hover:text-white font-bold cursor-pointer">Root (intake/)</button>
        {currentPath.split('/').filter(Boolean).map((part, index, arr) => {
          const pathUpToHere = arr.slice(0, index + 1).join('/');
          return (
            <React.Fragment key={pathUpToHere}>
              <span className="text-slate-600">/</span>
              <button 
                onClick={() => setCurrentPath(pathUpToHere)}
                className="text-blue-400 hover:text-white font-bold cursor-pointer"
              >
                {part}
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/* Explorer Grid */}
      <div className="flex-1 overflow-y-auto bg-black/20 rounded-lg border border-white/5 p-4 custom-scrollbar">
        {loading ? (
          <div className="text-slate-500 text-sm text-center py-10 animate-pulse">Scanning Archive...</div>
        ) : content.length === 0 ? (
          <div className="text-slate-500 text-sm text-center py-10 flex flex-col items-center">
            <svg className="w-12 h-12 mb-3 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
            This folder is empty.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {content.map((item: any) => (
              <div 
                key={item.id} 
                className="group relative bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/20 rounded-xl p-4 flex flex-col items-center justify-center text-center transition-all cursor-pointer h-32"
                onClick={() => item.type === 'folder' ? setCurrentPath(item.id) : null}
              >
                <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                    className="p-1.5 bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white rounded transition-colors"
                    title="Delete"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
                
                {item.type === 'folder' ? (
                  <svg className="w-12 h-12 text-emerald-500/80 mb-2" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg>
                ) : (
                  <svg className="w-10 h-10 text-slate-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                )}
                <span className="text-xs font-bold text-slate-200 truncate w-full px-2" title={item.name}>{item.name}</span>
                {item.type === 'file' && (
                  <span className="text-[9px] text-slate-500 mt-1">{(item.size / 1024).toFixed(1)} KB</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
