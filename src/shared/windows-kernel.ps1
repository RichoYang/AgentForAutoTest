param([string]$Operation,[string]$Payload)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$argValue=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
if($Operation -in @('lock','guard','probe')) { Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AgentOSKernel {
 static System.Threading.Tasks.Task<int> pipe;
 public static void WatchPipe(){pipe=System.Threading.Tasks.Task.Run(()=>Console.OpenStandardInput().ReadByte());}
 public static bool PipeClosed(){return pipe.IsCompleted;}
 public static void WaitPipe(){pipe.Wait();}
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFile(string n,uint a,uint s,IntPtr sa,uint d,uint f,IntPtr t);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out FileInfo i);
 [StructLayout(LayoutKind.Sequential)] struct FileInfo {public uint attributes;public long created,accessed,written;public uint volume,high,low,links,indexHigh,indexLow;}
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint a,bool i,string n);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,uint l);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr p,uint l,IntPtr r);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr p,int c,out ProcessBasic b,int n,out int r);
 [StructLayout(LayoutKind.Sequential)] struct ProcessBasic {public IntPtr reserved,peb,a,b,pid,parent;}
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] struct Limits {public long perProcess,perJob;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct Io {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] struct Extended {public Limits limits;public Io io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 public static SafeFileHandle Lock(string file) {
  var h=CreateFile(file,0xC0000000,0,IntPtr.Zero,4,0x00200080,IntPtr.Zero);
  if(h.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
  FileInfo info;if(!GetFileInformationByHandle(h,out info)){h.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}
  if((info.attributes & (0x10|0x400))!=0){h.Dispose();throw new Exception("Snapshot lock is a directory or reparse point");}return h;
 }
 public static string Identity(int pid) {
  var p=OpenProcess(0x1000,false,pid);if(p==IntPtr.Zero){int e=Marshal.GetLastWin32Error();if(e==87||e==1168)return null;throw new Win32Exception(e);}
  try{long c,e,k,u;if(!GetProcessTimes(p,out c,out e,out k,out u))throw new Win32Exception(Marshal.GetLastWin32Error());return e==0?c.ToString():null;}finally{CloseHandle(p);}
 }
 public static IntPtr Guard(string name,int pid,int owner) {
  var j=CreateJobObject(IntPtr.Zero,name);int code=Marshal.GetLastWin32Error();if(j==IntPtr.Zero)throw new Win32Exception(code);
  if(code==183){CloseHandle(j);throw new Exception("Job name already owned");}
  try{var limit=new Extended();limit.limits.flags=0x2000;int size=Marshal.SizeOf(limit);var b=Marshal.AllocHGlobal(size);
   try{Marshal.StructureToPtr(limit,b,false);if(!SetInformationJobObject(j,9,b,(uint)size))throw new Win32Exception(Marshal.GetLastWin32Error());}finally{Marshal.FreeHGlobal(b);}
   var p=OpenProcess(0x1501,false,pid);if(p==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"Open worker process");
   try{ProcessBasic basic;int length;if(NtQueryInformationProcess(p,0,out basic,Marshal.SizeOf(typeof(ProcessBasic)),out length)!=0||basic.parent.ToInt64()!=owner)throw new Exception("Worker parent identity mismatch");if(!AssignProcessToJobObject(j,p))throw new Win32Exception(Marshal.GetLastWin32Error(),"Assign worker Job Object");}finally{CloseHandle(p);}return j;
  }catch{CloseHandle(j);throw;}
 }
 public static int Active(string name) {
  var j=OpenJobObject(4,false,name);if(j==IntPtr.Zero){int e=Marshal.GetLastWin32Error();if(e==2)return 0;throw new Win32Exception(e);}
  try{var p=Marshal.AllocHGlobal(48);try{if(!QueryInformationJobObject(j,1,p,48,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());return Marshal.ReadInt32(p,40);}finally{Marshal.FreeHGlobal(p);}}finally{CloseHandle(j);}
 }
}
'@
}
function New-PrivateAcl([bool]$Directory) {
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 if($Directory){$acl=New-Object Security.AccessControl.DirectorySecurity;$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{$acl=New-Object Security.AccessControl.FileSecurity;$inherit=[Security.AccessControl.InheritanceFlags]::None}
 $acl.SetAccessRuleProtection($true,$false)
 foreach($principal in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){$rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl',$inherit,'None','Allow');$acl.AddAccessRule($rule)}
 return $acl
}
try {
 switch($Operation) {
  'lock' {
   [AgentOSKernel]::WatchPipe()
   $handle=$null
   while($null -eq $handle){if([AgentOSKernel]::PipeClosed()){throw 'Lock owner pipe closed'};try{$handle=[AgentOSKernel]::Lock($argValue.file)}catch{
    $cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException}
    if($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -in @(32,33)){Start-Sleep -Milliseconds 50}else{throw}
   }}
   try{[Console]::Out.WriteLine('{"locked":true}');[Console]::Out.Flush();[AgentOSKernel]::WaitPipe()}finally{$handle.Dispose()}
  }
  'guard' {
   $handle=[AgentOSKernel]::Guard($argValue.name,[int]$argValue.workerPid,[int]$argValue.ownerPid)
   try{@{guarded=$true;name=$argValue.name;ownerCreated=[AgentOSKernel]::Identity([int]$argValue.ownerPid);workerCreated=[AgentOSKernel]::Identity([int]$argValue.workerPid)} | ConvertTo-Json -Compress;[Console]::Out.Flush();[Console]::In.ReadToEnd() | Out-Null}finally{[AgentOSKernel]::CloseHandle($handle) | Out-Null}
  }
  'probe' {
   $proof=@{ownerCreated=$null;workerCreated=$null;active=$null;errors=@()}
   foreach($role in @('owner','worker','job')){
    try{if($role -eq 'job'){$proof.active=[AgentOSKernel]::Active($argValue.name)}else{$key=$role+'Created';$pidValue=$argValue.($role+'Pid');$proof[$key]=[AgentOSKernel]::Identity([int]$pidValue)}}catch{
     $cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException}
     $proof.errors+=@{field=$role;code=if($cause -is [ComponentModel.Win32Exception]){$cause.NativeErrorCode}else{$cause.GetType().Name};message=$cause.Message}
    }
   }
   $proof | ConvertTo-Json -Depth 5 -Compress
  }
  'acl' {
   $isDirectory=[IO.Directory]::Exists($argValue.file)
   if([IO.File]::GetAttributes($argValue.file) -band [IO.FileAttributes]::ReparsePoint){throw 'Private path cannot be a reparse point'}
   $acl=New-PrivateAcl $isDirectory
   if($isDirectory){[IO.Directory]::SetAccessControl($argValue.file,$acl)}else{[IO.File]::SetAccessControl($argValue.file,$acl)}
   @{private=$true} | ConvertTo-Json -Compress
  }
  'privateDirectory' {
   [IO.Directory]::CreateDirectory($argValue.file,(New-PrivateAcl $true)) | Out-Null
   @{createdOrExisting=$true} | ConvertTo-Json -Compress
  }
  'privateWrite' {
   $stream=[IO.FileStream]::new($argValue.file,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::None,(New-PrivateAcl $false))
   try{[Console]::Out.WriteLine('{"created":true}');[Console]::Out.Flush();[Console]::OpenStandardInput().CopyTo($stream);$stream.Flush($true)}finally{$stream.Dispose()}
  }
  'inspectAcl' {
   if([IO.Directory]::Exists($argValue.file)){$acl=[IO.Directory]::GetAccessControl($argValue.file)}else{$acl=[IO.File]::GetAccessControl($argValue.file)}
   @{protected=$acl.AreAccessRulesProtected;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {@{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights;allow=$_.AccessControlType -eq 'Allow';inherited=$_.IsInherited}})} | ConvertTo-Json -Depth 5 -Compress
  }
  default {throw 'Unknown Windows kernel operation'}
 }
}catch{[Console]::Error.WriteLine($_.Exception.ToString());exit 1}
