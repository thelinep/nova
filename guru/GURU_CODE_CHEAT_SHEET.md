# Guru-Code language and Git cheat sheet

This sheet is a learning and data-curation reference for Guru-Code. The
examples are intentionally small; they are not capability tests. Listing a
language, format, or Git workflow here does **not** mean Guru currently supports
it. Python is the only language with current Guru-Code fixture/parser coverage.
Every future model claim needs pinned toolchains, representative hidden tasks,
and relevant checks. For executable code, use the approved isolated evaluator,
never an approved project folder.

Code examples use conventional syntax. Brahmi comments or explanations may be
stored as separate teaching material; do not transliterate identifiers or
syntax in these examples.

## Programming and command languages

### Python

General-purpose language with a concise syntax, commonly used for scripting,
automation, web services, data work and tooling.

```python
def greet(name: str) -> str:
    return f"Hello, {name}!"

print(greet("Guru"))
```

Docs: [Python Tutorial](https://docs.python.org/3/tutorial/)

### Go

Compiled language with built-in support for packages, concurrency and simple
deployment of command-line and server programs.

```go
package main

import "fmt"

func main() {
	fmt.Println("Hello, Guru!")
}
```

Docs: [Go documentation](https://go.dev/doc/)

### C

Compiled systems language that exposes memory and hardware-level operations.
The sample follows the C standard library; exact compiler flags and standard
version must be pinned for evaluation.

```c
#include <stdio.h>

int main(void) {
    puts("Hello, Guru!");
    return 0;
}
```

Docs: [GCC C implementation manuals](https://gcc.gnu.org/onlinedocs/),
[C language reference](https://en.cppreference.com/w/c/language.html)

### C++

Compiled multi-paradigm language used for systems, applications and performance-
sensitive software. Pin the selected C++ standard and compiler.

```cpp
#include <iostream>

int main() {
    std::cout << "Hello, Guru!\n";
}
```

Docs: [C++ working draft](https://eel.is/c++draft/),
[C++ reference](https://en.cppreference.com/w/)

### C#

Strongly typed language in the .NET ecosystem for applications, services,
desktop software and games.

```csharp
string Greet(string name) => $"Hello, {name}!";

Console.WriteLine(Greet("Guru"));
```

Docs: [Microsoft C# documentation](https://learn.microsoft.com/dotnet/csharp/)

### Rust

Compiled systems language focused on memory safety and concurrency without a
garbage collector.

```rust
fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}

fn main() {
    println!("{}", greet("Guru"));
}
```

Docs: [The Rust Programming Language](https://doc.rust-lang.org/book/)

### JavaScript

Dynamic language standardized as ECMAScript and used in browsers, servers and
tooling.

```javascript
function greet(name) {
  return `Hello, ${name}!`;
}

console.log(greet("Guru"));
```

Docs: [ECMAScript specification](https://tc39.es/ecma262/),
[MDN JavaScript Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide)

### TypeScript

JavaScript with a static type system; TypeScript source is checked and then
transformed for the chosen JavaScript runtime or build target.

```typescript
function greet(name: string): string {
  return `Hello, ${name}!`;
}

console.log(greet("Guru"));
```

Docs: [TypeScript Handbook](https://www.typescriptlang.org/docs/)

### Java

Class-based language commonly used for server, desktop, Android and enterprise
software; pin the JDK and language release used by each task.

```java
class Main {
    static String greet(String name) {
        return "Hello, " + name + "!";
    }

    public static void main(String[] args) {
        System.out.println(greet("Guru"));
    }
}
```

Docs: [dev.java learning resources](https://dev.java/learn/)

### Bash

GNU shell commonly used for interactive work and automation on Linux and
macOS. Bash-specific features must be labeled as such.

```bash
#!/usr/bin/env bash
set -euo pipefail

name="Guru"
printf 'Hello, %s!\n' "$name"
```

Docs: [GNU Bash Reference Manual](https://www.gnu.org/software/bash/manual/)

### POSIX shell

Portable shell language defined by POSIX. Keep examples within the selected
POSIX edition and run them with a compatible shell.

```sh
#!/bin/sh
set -eu

name=${1:-Guru}
printf 'Hello, %s!\n' "$name"
```

Docs: [The Open Group Shell Command Language](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html)

### PowerShell

Cross-platform command shell and scripting language built around structured
objects and cmdlets.

```powershell
param([string]$Name = "Guru")

Write-Output "Hello, $Name!"
```

Docs: [Microsoft PowerShell documentation](https://learn.microsoft.com/powershell/)

## Markup, style, query and data formats

### HTML

Markup for structuring web documents and accessible user interfaces.

```html
<main>
  <h1>Hello, Guru!</h1>
  <p>A small semantic HTML example.</p>
</main>
```

Docs: [WHATWG HTML Living Standard](https://html.spec.whatwg.org/)

### XML

Extensible, tree-structured markup used for documents and data interchange;
elements must be properly nested and escaped.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<greeting language="en">
  <text>Hello, Guru!</text>
</greeting>
```

Docs: [W3C XML 1.0](https://www.w3.org/TR/xml/)

### CSS

Style-sheet language that controls the presentation and layout of HTML and
other structured documents.

```css
.greeting {
  color: navy;
  font-weight: 600;
}
```

Docs: [W3C CSS](https://www.w3.org/Style/CSS/),
[MDN CSS reference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference)

### SQL

Declarative language for defining, querying and changing relational data.
Syntax and behavior vary by database, so this sample explicitly uses
PostgreSQL-style SQL.

```sql
CREATE TABLE greetings (
    id INTEGER PRIMARY KEY,
    message TEXT NOT NULL
);

INSERT INTO greetings (id, message) VALUES (1, 'Hello, Guru!');
SELECT message FROM greetings WHERE id = 1;
```

Docs: [PostgreSQL SQL commands](https://www.postgresql.org/docs/current/sql-commands.html)

### JSON

Text data format for values and nested objects. JSON has no comments, allows
double-quoted strings, and does not permit trailing commas.

```json
{
  "language": "en",
  "message": "Hello, Guru!",
  "ready": true
}
```

Docs: [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259),
[ECMA-404 JSON](https://ecma-international.org/publications-and-standards/standards/ecma-404/)

## Developer tooling

### Git

Distributed version control for recording, comparing and sharing project
history. These commands show a review-first local workflow. They do not grant a
model permission to stage, commit, or push changes; Maataa's approval rules
remain authoritative.

```sh
# Inspect the working tree.
git status --short

# Interactively choose only the intended hunks for the next commit.
git add -p

# Review exactly what is staged.
git diff --cached

# Record the reviewed staged snapshot.
git commit -m "Add greeting example"

# Inspect the new commit.
git log -1 --oneline
```

`git add -p` asks which change hunks to stage. Review `git diff --cached`
before committing; it shows what the next commit will contain. Avoid broad
staging when unrelated work is present. This sheet does not include `git push`:
publishing commits is a separate, explicitly authorized action.

Docs: [Git reference](https://git-scm.com/docs/),
[Git tutorial](https://git-scm.com/docs/gittutorial)

## How to use this sheet for Guru

For each target, turn reviewed examples into distinct, linked records rather
than isolated code/answer pairs:

1. **Intent:** request, acceptance criteria, assumptions and safety constraints.
2. **Context:** immutable source/repository revision, relevant files, symbols,
   dependencies and toolchain versions.
3. **Change:** proposed patch or document, with its author/source and digest.
4. **Explanation:** concise rationale; optional Brahmi explanation is a
   separate field and never changes code identifiers or syntax.
5. **Evidence:** parser/compiler/runtime versions, commands, tests, bounded raw
   results and evaluator image digest.
6. **Outcome:** accepted, rejected, revised, or unresolved, with the human
   review evidence and links to prior attempts.
7. **Governance:** source item, immutable revision, license, permissions,
   attribution, transformation history, duplicate/leakage group and split. For
   teacher-generated material, also record the teacher/adapter digest, tokenizer,
   context, runtime/API revision, access mode, prompt, decoding settings, raw
   response, filtering steps and separate output/training/weight permissions.

Keep training, retrieval-only, evaluation-only and unresolved material in
separate pools. A teacher-generated answer is a derived source with its own
provenance and rights review; it is not ground truth merely because a model
produced it. Keep evaluation targets out of training and tuning.

## Current support boundary

The listed languages, formats and Git are roadmap/data targets only. Current
fixtures and syntax checks remain Python-only. No representative approved
corpus or coding-qualified Guru checkpoint is established by this sheet.
