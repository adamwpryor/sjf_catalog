import { NextResponse } from 'next/server';
import { getStorageClient, resolveBucketName } from '@/lib/gcs';

export const dynamic = 'force-dynamic';

// Helper to convert flat GCS file list into nested hierarchical JSON structure
function buildStructureFromFiles(files: any[], prefix: string): any[] {
  const structure: any[] = [];
  const map = new Map<string, any>();
  
  files.forEach(file => {
    // file.name is the full path e.g., 'intake/folder1/file.pdf'
    // Remove the base prefix (e.g. 'intake/') to get relative paths
    if (!file.name.startsWith(prefix)) return;
    const relPath = file.name.substring(prefix.length);
    if (!relPath) return; // Skip the root 'intake/' directory marker if it exists

    const parts = relPath.split('/');
    let currentPath = '';

    parts.forEach((part: string, index: number) => {
      if (!part) return; // Skip empty parts
      
      const isFolder = (index < parts.length - 1) || (file.name.endsWith('/'));
      const isZeroByteMarker = (!isFolder && part === '.keep');
      
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!map.has(currentPath) && !isZeroByteMarker) {
        const item: any = {
          id: currentPath,
          name: part,
          type: isFolder ? 'folder' : 'file',
        };
        
        if (isFolder) {
          item.children = [];
        } else {
          item.size = Number(file.metadata.size);
          item.updatedAt = file.metadata.updated;
        }

        map.set(currentPath, item);

        if (parentPath === '') {
          structure.push(item);
        } else {
          const parentFolder = map.get(parentPath);
          if (parentFolder && parentFolder.children) {
            parentFolder.children.push(item);
          }
        }
      } else if (isFolder && !map.has(currentPath)) {
          // It's a folder, ensure it exists in the map
          const item: any = {
              id: currentPath,
              name: part,
              type: 'folder',
              children: []
          };
          map.set(currentPath, item);
          if (parentPath === '') {
            structure.push(item);
          } else {
            const parentFolder = map.get(parentPath);
            if (parentFolder && parentFolder.children) {
              parentFolder.children.push(item);
            }
          }
      }
    });
  });

  return structure;
}

export async function GET(req: Request) {
  try {
    const storage = await getStorageClient(req);
    const bucketName = resolveBucketName();
    const bucket = storage.bucket(bucketName);
    
    // Prefix for the intake filing cabinet
    const prefix = 'intake/';
    
    const [files] = await bucket.getFiles({ prefix });
    
    const structure = buildStructureFromFiles(files, prefix);
    
    return NextResponse.json({ success: true, data: structure });
  } catch (e: any) {
    console.error("Intake GET Error:", e);
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const storage = await getStorageClient(req);
    const bucketName = resolveBucketName();
    const bucket = storage.bucket(bucketName);
    const prefix = 'intake/';
    
    // Handle multipart form data for uploads
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const files = formData.getAll('file') as File[];
      const targetFolder = (formData.get('targetFolder') as string) || '';
      
      if (!files || files.length === 0) return NextResponse.json({ error: "No files provided" }, { status: 400 });
      
      for (const file of files) {
        const sanitizedName = file.name.replace(/[^a-zA-Z0-9.\-_ ()]/g, '_');
        const gcsPath = targetFolder ? `${prefix}${targetFolder}/${sanitizedName}` : `${prefix}${sanitizedName}`;
        
        const buffer = Buffer.from(await file.arrayBuffer());
        const gcsFile = bucket.file(gcsPath);
        await gcsFile.save(buffer, {
          metadata: {
            contentType: file.type || 'application/octet-stream',
          }
        });
      }
      
      return NextResponse.json({ success: true, message: "Files uploaded successfully" });
    }

    // Handle JSON actions (create_folder, move, delete)
    const body = await req.json();
    const { action, payload } = body;

    if (action === 'create_folder') {
      const { parentPath, folderName } = payload;
      const sanitizedFolder = folderName.replace(/[^a-zA-Z0-9.\-_ ]/g, '_');
      
      // In GCS, creating a folder means uploading a 0-byte placeholder
      const gcsPath = parentPath 
        ? `${prefix}${parentPath}/${sanitizedFolder}/.keep`
        : `${prefix}${sanitizedFolder}/.keep`;
      
      await bucket.file(gcsPath).save('');
      return NextResponse.json({ success: true });
    }

    if (action === 'move') {
      const { sourcePath, targetPath } = payload;
      const src = `${prefix}${sourcePath}`;
      const dest = `${prefix}${targetPath}`;
      
      // If it's a folder, we need to move all files with that prefix
      const srcFile = bucket.file(src);
      const [exists] = await srcFile.exists();
      
      if (exists) {
        // It's a single file
        await srcFile.move(dest);
      } else {
        // It might be a folder
        const [files] = await bucket.getFiles({ prefix: src + '/' });
        if (files.length === 0) {
           return NextResponse.json({ error: "Source not found" }, { status: 404 });
        }
        for (const file of files) {
          const newName = file.name.replace(src + '/', dest + '/');
          await file.move(newName);
        }
      }
      return NextResponse.json({ success: true });
    }

    if (action === 'delete') {
      const { targetPath } = payload;
      const target = `${prefix}${targetPath}`;
      
      const targetFile = bucket.file(target);
      const [exists] = await targetFile.exists();
      
      if (exists) {
        // Single file
        await targetFile.delete();
      } else {
        // Directory
        const [files] = await bucket.getFiles({ prefix: target + '/' });
        for (const file of files) {
          await file.delete();
        }
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e: any) {
    console.error("Intake API Error:", e);
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
