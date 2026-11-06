param([string]$RootBase64,[string]$Filter='*.tmp')
$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Security.Principal;using System.Security.AccessControl;using System.Linq;using System.Threading;
public class CreationWatcher:IDisposable {
 FileSystemWatcher watcher;ManualResetEvent done=new ManualResetEvent(false);public string file,error;public bool protect,directory;public string[] allows;
 public CreationWatcher(string root,string filter){watcher=new FileSystemWatcher(root,filter);watcher.Created+=(s,e)=>{try{file=e.Name;directory=Directory.Exists(e.FullPath);FileSystemSecurity acl=directory?(FileSystemSecurity)Directory.GetAccessControl(e.FullPath):File.GetAccessControl(e.FullPath);protect=acl.AreAccessRulesProtected;allows=acl.GetAccessRules(true,true,typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().Where(r=>r.AccessControlType==AccessControlType.Allow).Select(r=>r.IdentityReference.Value).ToArray();}catch(Exception x){error=x.ToString();}finally{done.Set();}};watcher.EnableRaisingEvents=true;}
 public void Wait(){if(!done.WaitOne(20000))throw new Exception("Owned creation event not observed");if(error!=null)throw new Exception(error);}
 public void Dispose(){watcher.Dispose();done.Dispose();}
}
'@
$root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RootBase64));$watcher=New-Object CreationWatcher($root,$Filter)
try{[Console]::Out.WriteLine('ready');[Console]::Out.Flush();$watcher.Wait();@{file=$watcher.file;directory=$watcher.directory;protected=$watcher.protect;allows=$watcher.allows} | ConvertTo-Json -Compress}finally{$watcher.Dispose()}
