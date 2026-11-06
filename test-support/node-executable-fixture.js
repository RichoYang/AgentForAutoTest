import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
// A native Windows executable for tests that exercise shell:false. No production wrapper or PATH change.
export async function nodeExecutableFixture(file,program){
 if(process.platform!=='win32'){await writeFile(file,`#!${process.execPath}\n${program}`,{mode:0o700});return file;}
 const script=file+'.cjs',executable=file+'.exe';await writeFile(script,program);
 const literal=s=>'@"'+s.replaceAll('"','""')+'"';
 const source=`using System;using System.Diagnostics;using System.Text;using System.Threading.Tasks;class Fixture {static string Q(string s){var b=new StringBuilder("\\\"");int n=0;foreach(char c in s){if(c=='\\\\'){n++;continue;}if(c=='"'){b.Append('\\\\',n*2+1);b.Append(c);}else{b.Append('\\\\',n);b.Append(c);}n=0;}b.Append('\\\\',n*2);b.Append('"');return b.ToString();}static int Main(string[] args){var b=new StringBuilder(Q(${literal(script)}));foreach(var a in args)b.Append(" "+Q(a));var p=Process.Start(new ProcessStartInfo(${literal(process.execPath)},b.ToString()){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true});var output=p.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());var error=p.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());Console.OpenStandardInput().CopyTo(p.StandardInput.BaseStream);p.StandardInput.Close();p.WaitForExit();Task.WaitAll(output,error);return p.ExitCode;}}`;
 const encode=s=>Buffer.from(s).toString('base64');
 const command=`$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(source)}'));$f=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(executable)}'));Add-Type -TypeDefinition $s -OutputAssembly $f -OutputType ConsoleApplication -ErrorAction Stop`;
 await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true});return executable;
}
