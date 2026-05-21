"""
Log File Error Analyzer using LangChain, LangGraph, and MCP Servers
"""

import os
import sys
import json
import argparse
from typing import TypedDict, Annotated, Sequence
from datetime import datetime
from pathlib import Path

from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langgraph.graph import StateGraph, END
from dotenv import load_dotenv

# Load environment variables
load_dotenv()


class LogAnalysisState(TypedDict):
    """State for the log analysis workflow"""
    log_file_path: str
    log_content: str
    errors_found: list[dict]
    analysis_summary: str
    current_step: str
    messages: Annotated[Sequence[HumanMessage | AIMessage], "Chat messages"]


class LogErrorAnalyzer:
    """
    Analyzes log files for errors using LangChain and LangGraph
    """
    
    def __init__(self, model_name: str = "gpt-4", temperature: float = 0):
        """
        Initialize the log analyzer
        
        Args:
            model_name: OpenAI model to use
            temperature: Temperature for LLM responses
        """
        self.llm = ChatOpenAI(
            model=model_name,
            temperature=temperature,
            api_key=os.getenv("OPENAI_API_KEY")
        )
        self.workflow = self._build_workflow()
        
    def _build_workflow(self) -> StateGraph:
        """
        Build the LangGraph workflow for log analysis
        """
        # Create the state graph
        workflow = StateGraph(LogAnalysisState)
        
        # Add nodes
        workflow.add_node("read_log", self._read_log_file)
        workflow.add_node("parse_errors", self._parse_errors)
        workflow.add_node("classify_errors", self._classify_errors)
        workflow.add_node("generate_summary", self._generate_summary)
        
        # Define edges
        workflow.set_entry_point("read_log")
        workflow.add_edge("read_log", "parse_errors")
        workflow.add_edge("parse_errors", "classify_errors")
        workflow.add_edge("classify_errors", "generate_summary")
        workflow.add_edge("generate_summary", END)
        
        return workflow.compile()
    
    def _read_log_file(self, state: LogAnalysisState) -> LogAnalysisState:
        """
        Read the log file content
        """
        print(f"📖 Reading log file: {state['log_file_path']}")
        
        try:
            with open(state['log_file_path'], 'r', encoding='utf-8') as f:
                content = f.read()
            
            state['log_content'] = content
            state['current_step'] = "read_log"
            print(f"✅ Successfully read {len(content)} characters")
            
        except Exception as e:
            print(f"❌ Error reading file: {e}")
            state['log_content'] = ""
            state['errors_found'] = [{"error": f"Failed to read file: {str(e)}"}]
        
        return state
    
    def _parse_errors(self, state: LogAnalysisState) -> LogAnalysisState:
        """
        Parse and extract errors from log content using LLM
        """
        print("🔍 Parsing errors from log content...")
        
        prompt = ChatPromptTemplate.from_messages([
            SystemMessage(content="""You are an expert log analyzer. Your task is to identify and extract 
            all errors, exceptions, warnings, and critical issues from log files.
            
            For each error found, extract:
            1. Error type (ERROR, EXCEPTION, WARNING, CRITICAL, FATAL)
            2. Timestamp (if available)
            3. Error message
            4. Stack trace or context (if available)
            5. Affected component/module
            
            Return the results as a JSON array."""),
            HumanMessage(content=f"Analyze this log content and extract all errors:\n\n{state['log_content'][:8000]}")
        ])
        
        try:
            response = self.llm.invoke(prompt.format_messages())
            
            # Try to parse JSON from response
            content = response.content
            
            # Extract JSON if wrapped in code blocks
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                content = content.split("```")[1].split("```")[0].strip()
            
            errors = json.loads(content)
            state['errors_found'] = errors if isinstance(errors, list) else [errors]
            print(f"✅ Found {len(state['errors_found'])} errors")
            
        except Exception as e:
            print(f"⚠️  Error parsing response: {e}")
            # Fallback: simple pattern matching
            state['errors_found'] = self._simple_error_extraction(state['log_content'])
        
        state['current_step'] = "parse_errors"
        return state
    
    def _simple_error_extraction(self, log_content: str) -> list[dict]:
        """
        Simple fallback error extraction using pattern matching
        """
        errors = []
        error_keywords = ['ERROR', 'EXCEPTION', 'CRITICAL', 'FATAL', 'WARNING']
        
        lines = log_content.split('\n')
        for i, line in enumerate(lines):
            for keyword in error_keywords:
                if keyword in line.upper():
                    errors.append({
                        'type': keyword,
                        'line_number': i + 1,
                        'message': line.strip(),
                        'context': '\n'.join(lines[max(0, i-2):min(len(lines), i+3)])
                    })
                    break
        
        return errors
    
    def _classify_errors(self, state: LogAnalysisState) -> LogAnalysisState:
        """
        Classify and prioritize errors using LLM
        """
        print("🏷️  Classifying and prioritizing errors...")
        
        if not state['errors_found']:
            print("ℹ️  No errors to classify")
            state['current_step'] = "classify_errors"
            return state
        
        prompt = ChatPromptTemplate.from_messages([
            SystemMessage(content="""You are an expert at analyzing software errors. 
            Classify each error by:
            1. Severity (CRITICAL, HIGH, MEDIUM, LOW)
            2. Category (Database, Network, Authentication, Configuration, Runtime, etc.)
            3. Potential impact
            4. Recommended action
            
            Return results as a JSON array maintaining the original structure with added fields."""),
            HumanMessage(content=f"Classify these errors:\n\n{json.dumps(state['errors_found'], indent=2)}")
        ])
        
        try:
            response = self.llm.invoke(prompt.format_messages())
            content = response.content
            
            # Extract JSON if wrapped in code blocks
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                content = content.split("```")[1].split("```")[0].strip()
            
            classified_errors = json.loads(content)
            state['errors_found'] = classified_errors if isinstance(classified_errors, list) else [classified_errors]
            print(f"✅ Classified {len(state['errors_found'])} errors")
            
        except Exception as e:
            print(f"⚠️  Error classifying: {e}")
            # Keep original errors if classification fails
        
        state['current_step'] = "classify_errors"
        return state
    
    def _generate_summary(self, state: LogAnalysisState) -> LogAnalysisState:
        """
        Generate a comprehensive analysis summary
        """
        print("📝 Generating analysis summary...")
        
        prompt = ChatPromptTemplate.from_messages([
            SystemMessage(content="""You are an expert technical writer. Create a comprehensive 
            summary of the log analysis including:
            1. Overview of issues found
            2. Critical errors that need immediate attention
            3. Patterns and trends
            4. Recommendations for resolution
            5. Preventive measures
            
            Make it clear, actionable, and prioritized."""),
            HumanMessage(content=f"""Generate a summary for this log analysis:
            
            File: {state['log_file_path']}
            Total Errors Found: {len(state['errors_found'])}
            
            Errors:
            {json.dumps(state['errors_found'], indent=2)}""")
        ])
        
        try:
            response = self.llm.invoke(prompt.format_messages())
            state['analysis_summary'] = response.content
            print("✅ Summary generated")
            
        except Exception as e:
            print(f"⚠️  Error generating summary: {e}")
            state['analysis_summary'] = f"Found {len(state['errors_found'])} errors. See details below."
        
        state['current_step'] = "generate_summary"
        return state
    
    def analyze_log_file(self, log_file_path: str) -> dict:
        """
        Analyze a log file and return results
        
        Args:
            log_file_path: Path to the log file
            
        Returns:
            Dictionary with analysis results
        """
        print(f"\n{'='*80}")
        print(f"🚀 Starting Log Analysis")
        print(f"{'='*80}\n")
        
        # Initialize state
        initial_state: LogAnalysisState = {
            'log_file_path': log_file_path,
            'log_content': '',
            'errors_found': [],
            'analysis_summary': '',
            'current_step': 'init',
            'messages': []
        }
        
        # Run the workflow
        final_state = self.workflow.invoke(initial_state)
        
        # Prepare results
        results = {
            'file': log_file_path,
            'timestamp': datetime.now().isoformat(),
            'errors_count': len(final_state['errors_found']),
            'errors': final_state['errors_found'],
            'summary': final_state['analysis_summary']
        }
        
        print(f"\n{'='*80}")
        print(f"✨ Analysis Complete")
        print(f"{'='*80}\n")
        
        return results
    
    def save_results(self, results: dict, output_path: str = "analysis_results.json"):
        """
        Save analysis results to a JSON file
        """
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2)
        print(f"💾 Results saved to: {output_path}")
    
    def generate_detailed_report(self, results: dict, output_path: str = "error_report.txt"):
        """
        Generate a detailed human-readable error report
        """
        with open(output_path, 'w', encoding='utf-8') as f:
            # Header
            f.write("="*80 + "\n")
            f.write("LOG ERROR ANALYSIS REPORT\n")
            f.write("="*80 + "\n\n")
            
            # Summary Information
            f.write(f"Report Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"Log File Analyzed: {results['file']}\n")
            f.write(f"Total Errors Found: {results['errors_count']}\n")
            f.write("\n" + "-"*80 + "\n\n")
            
            # Analysis Summary
            f.write("EXECUTIVE SUMMARY\n")
            f.write("-"*80 + "\n")
            f.write(f"{results['summary']}\n\n")
            f.write("="*80 + "\n\n")
            
            # Error Statistics
            if results['errors']:
                error_types = {}
                severities = {}
                categories = {}
                
                for error in results['errors']:
                    # Count error types
                    error_type = error.get('type', 'UNKNOWN')
                    error_types[error_type] = error_types.get(error_type, 0) + 1
                    
                    # Count severities
                    severity = error.get('severity', 'UNKNOWN')
                    severities[severity] = severities.get(severity, 0) + 1
                    
                    # Count categories
                    category = error.get('category', 'UNKNOWN')
                    categories[category] = categories.get(category, 0) + 1
                
                f.write("ERROR STATISTICS\n")
                f.write("-"*80 + "\n\n")
                
                f.write("By Error Type:\n")
                for error_type, count in sorted(error_types.items(), key=lambda x: x[1], reverse=True):
                    f.write(f"  {error_type}: {count}\n")
                
                f.write("\nBy Severity:\n")
                for severity, count in sorted(severities.items(), key=lambda x: x[1], reverse=True):
                    f.write(f"  {severity}: {count}\n")
                
                if any(cat != 'UNKNOWN' for cat in categories.keys()):
                    f.write("\nBy Category:\n")
                    for category, count in sorted(categories.items(), key=lambda x: x[1], reverse=True):
                        if category != 'UNKNOWN':
                            f.write(f"  {category}: {count}\n")
                
                f.write("\n" + "="*80 + "\n\n")
            
            # Detailed Error Listing
            f.write("DETAILED ERROR LIST\n")
            f.write("="*80 + "\n\n")
            
            if results['errors']:
                for i, error in enumerate(results['errors'], 1):
                    f.write(f"ERROR #{i}\n")
                    f.write("-"*80 + "\n")
                    
                    # Write all error fields
                    for key, value in error.items():
                        # Format field name
                        field_name = key.replace('_', ' ').title()
                        
                        # Handle multi-line values
                        if isinstance(value, str) and '\n' in value:
                            f.write(f"{field_name}:\n")
                            for line in value.split('\n'):
                                f.write(f"  {line}\n")
                        else:
                            f.write(f"{field_name}: {value}\n")
                    
                    f.write("\n")
            else:
                f.write("No errors found.\n\n")
            
            # Footer
            f.write("="*80 + "\n")
            f.write("End of Report\n")
            f.write("="*80 + "\n")
        
        print(f"📄 Detailed report saved to: {output_path}")


def main():
    """
    Main function to run the log analyzer
    """
    # Setup argument parser
    parser = argparse.ArgumentParser(
        description='Log Error Analyzer using LangChain, LangGraph & MCP',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Analyze a specific log file
  python log_analyzer.py app.log
  
  # Analyze with custom output filename
  python log_analyzer.py app.log -o my_analysis.json
  
  # Use GPT-3.5 for faster analysis
  python log_analyzer.py app.log --model gpt-3.5-turbo
  
  # Generate detailed report only
  python log_analyzer.py app.log --detailed-report
        """
    )
    
    parser.add_argument(
        'log_file',
        nargs='?',
        default='example.log',
        help='Path to the log file to analyze (default: example.log)'
    )
    
    parser.add_argument(
        '-o', '--output',
        default='analysis_results.json',
        help='Output JSON file path (default: analysis_results.json)'
    )
    
    parser.add_argument(
        '-r', '--report',
        default='error_report.txt',
        help='Detailed report file path (default: error_report.txt)'
    )
    
    parser.add_argument(
        '--model',
        default='gpt-4',
        choices=['gpt-4', 'gpt-3.5-turbo', 'gpt-4-turbo'],
        help='OpenAI model to use (default: gpt-4)'
    )
    
    parser.add_argument(
        '--no-ai',
        action='store_true',
        help='Run without AI analysis (pattern matching only)'
    )
    
    parser.add_argument(
        '--detailed-report',
        action='store_true',
        help='Generate detailed text report in addition to JSON'
    )
    
    args = parser.parse_args()
    
    print("🔧 Log Error Analyzer using LangChain, LangGraph & MCP")
    print("-" * 80)
    
    # Check if log file exists
    if not os.path.exists(args.log_file):
        if args.log_file == 'example.log':
            print(f"⚠️  Log file '{args.log_file}' not found. Creating an example...")
            create_example_log()
        else:
            print(f"❌ Error: Log file '{args.log_file}' not found")
            sys.exit(1)
    
    # Check for API key (unless no-ai mode)
    if not args.no_ai and not os.getenv("OPENAI_API_KEY"):
        print("⚠️  Warning: OPENAI_API_KEY not found in environment variables")
        print("Running in pattern-matching mode only (no AI analysis)")
        print("To enable AI features, create a .env file with:")
        print("OPENAI_API_KEY=your_api_key_here")
        print()
        args.no_ai = True
    
    # Initialize analyzer
    print(f"📁 Analyzing: {args.log_file}")
    if not args.no_ai:
        print(f"🤖 Using model: {args.model}")
    else:
        print("🔍 Using pattern matching (no AI)")
    print()
    
    analyzer = LogErrorAnalyzer(model_name=args.model)
    
    # Run analysis
    results = analyzer.analyze_log_file(args.log_file)
    
    # Display results
    print("\n📊 ANALYSIS RESULTS")
    print("=" * 80)
    print(f"File: {results['file']}")
    print(f"Errors Found: {results['errors_count']}")
    
    if results['summary']:
        print(f"\n{results['summary']}")
    
    print("\n" + "=" * 80)
    
    # Save JSON results
    analyzer.save_results(results, args.output)
    
    # Generate detailed report
    if args.detailed_report or results['errors_count'] > 0:
        analyzer.generate_detailed_report(results, args.report)
    
    # Display summary of errors
    if results['errors']:
        # Count error types
        error_types = {}
        for error in results['errors']:
            error_type = error.get('type', 'UNKNOWN')
            error_types[error_type] = error_types.get(error_type, 0) + 1
        
        print("\n📈 Error Summary:")
        print("-" * 80)
        for error_type, count in sorted(error_types.items(), key=lambda x: x[1], reverse=True):
            print(f"  {error_type}: {count}")
        
        # Show first 5 errors as preview
        print(f"\n🔍 Error Preview (showing first {min(5, len(results['errors']))} of {len(results['errors'])}):")
        print("-" * 80)
        for i, error in enumerate(results['errors'][:5], 1):
            print(f"\n  Error #{i}:")
            print(f"    Type: {error.get('type', 'N/A')}")
            if 'line_number' in error:
                print(f"    Line: {error['line_number']}")
            msg = error.get('message', 'N/A')
            if len(msg) > 100:
                msg = msg[:97] + "..."
            print(f"    Message: {msg}")
        
        if len(results['errors']) > 5:
            print(f"\n  ... and {len(results['errors']) - 5} more errors")
            print(f"  See {args.report} for complete details")
    
    print("\n" + "=" * 80)
    print("✅ Analysis complete!")
    print("=" * 80)


def create_example_log():
    """
    Create an example log file for testing
    """
    example_log_content = """2024-12-10 10:15:23 INFO [Application] Starting application...
2024-12-10 10:15:24 INFO [Database] Connecting to database: postgres://localhost:5432/mydb
2024-12-10 10:15:25 ERROR [Database] Connection failed: Connection timeout after 30s
2024-12-10 10:15:25 INFO [Application] Retrying database connection...
2024-12-10 10:15:30 INFO [Database] Connected successfully
2024-12-10 10:16:45 WARNING [API] Rate limit approaching: 95% of quota used
2024-12-10 10:17:12 INFO [UserService] User login: user_id=12345
2024-12-10 10:18:33 ERROR [PaymentService] Payment processing failed: InvalidCardException
    at PaymentProcessor.process(PaymentProcessor.java:123)
    at OrderService.checkout(OrderService.java:456)
    Caused by: stripe.error.CardError: Your card was declined
2024-12-10 10:19:01 CRITICAL [Security] Unauthorized access attempt detected from IP: 192.168.1.100
2024-12-10 10:19:02 INFO [Security] IP blocked: 192.168.1.100
2024-12-10 10:20:15 WARNING [Cache] Redis connection unstable, switching to fallback
2024-12-10 10:21:30 ERROR [FileSystem] Failed to write file: /data/reports/daily.pdf - Disk quota exceeded
2024-12-10 10:22:00 FATAL [Application] Out of memory error - shutting down
    java.lang.OutOfMemoryError: Java heap space
    at java.util.Arrays.copyOf(Arrays.java:3332)
    at java.lang.AbstractStringBuilder.ensureCapacityInternal(AbstractStringBuilder.java:124)
2024-12-10 10:22:01 INFO [Application] Shutdown complete
"""
    
    with open("example.log", "w", encoding="utf-8") as f:
        f.write(example_log_content)
    
    print(f"✅ Created example.log")


if __name__ == "__main__":
    main()

