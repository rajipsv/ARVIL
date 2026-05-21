"""
Simple Log Error Analyzer using LangChain (without LangGraph)

A streamlined version that uses pure LangChain for log analysis.
"""

import os
import sys
import json
import argparse
from datetime import datetime
from typing import List, Dict, Any

from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# Load environment variables
load_dotenv()


class ErrorInfo(BaseModel):
    """Schema for error information"""
    type: str = Field(description="Error type (ERROR, WARNING, CRITICAL, FATAL)")
    line_number: int = Field(description="Line number where error occurred")
    message: str = Field(description="Error message")
    severity: str = Field(description="Severity level (CRITICAL, HIGH, MEDIUM, LOW)")
    category: str = Field(description="Error category (Database, Network, etc.)")
    recommendation: str = Field(description="Recommended action to fix the error")


class LogAnalysisResult(BaseModel):
    """Schema for complete analysis result"""
    errors: List[ErrorInfo] = Field(description="List of detected errors")
    summary: str = Field(description="Executive summary of findings")
    total_errors: int = Field(description="Total number of errors found")


class SimpleLogAnalyzer:
    """
    Simple log analyzer using pure LangChain
    """
    
    def __init__(self, model_name: str = "gpt-4", temperature: float = 0):
        """
        Initialize the analyzer
        
        Args:
            model_name: OpenAI model to use
            temperature: Temperature for LLM responses
        """
        self.llm = ChatOpenAI(
            model=model_name,
            temperature=temperature,
            api_key=os.getenv("OPENAI_API_KEY")
        )
        self.parser = JsonOutputParser(pydantic_object=LogAnalysisResult)
    
    def read_log_file(self, file_path: str) -> str:
        """Read log file content"""
        print(f"📖 Reading log file: {file_path}")
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            print(f"✅ Read {len(content)} characters")
            return content
        except Exception as e:
            print(f"❌ Error reading file: {e}")
            return ""
    
    def analyze_log(self, log_content: str) -> Dict[str, Any]:
        """
        Analyze log content using LangChain
        
        Args:
            log_content: Content of the log file
            
        Returns:
            Dictionary with analysis results
        """
        print("🔍 Analyzing log content with AI...")
        
        # Create prompt template
        prompt = ChatPromptTemplate.from_messages([
            ("system", """You are an expert log analyzer. Analyze the provided log content and identify all errors, warnings, and critical issues.

For each error found, provide:
1. type: The error type (ERROR, WARNING, CRITICAL, FATAL)
2. line_number: Approximate line number (count from 1)
3. message: The error message (concise)
4. severity: Severity level (CRITICAL, HIGH, MEDIUM, LOW)
5. category: Error category (Database, Network, Authentication, FileSystem, Memory, etc.)
6. recommendation: Specific action to fix the issue

Also provide:
- A comprehensive executive summary
- Total count of errors

Return the response in this JSON format:
{format_instructions}
"""),
            ("human", "Analyze this log file:\n\n{log_content}")
        ])
        
        # Create chain
        chain = prompt | self.llm | self.parser
        
        try:
            # Run analysis
            result = chain.invoke({
                "log_content": log_content[:8000],  # Limit to avoid token limits
                "format_instructions": self.parser.get_format_instructions()
            })
            
            print(f"✅ Analysis complete: Found {result.get('total_errors', 0)} errors")
            return result
            
        except Exception as e:
            print(f"⚠️  Error during AI analysis: {e}")
            # Fallback to simple pattern matching
            return self._simple_analysis(log_content)
    
    def _simple_analysis(self, log_content: str) -> Dict[str, Any]:
        """
        Fallback simple analysis without AI
        
        Args:
            log_content: Content of the log file
            
        Returns:
            Dictionary with basic analysis results
        """
        print("🔄 Using fallback pattern matching...")
        
        errors = []
        error_keywords = ['ERROR', 'CRITICAL', 'FATAL', 'WARNING', 'EXCEPTION']
        
        lines = log_content.split('\n')
        for i, line in enumerate(lines, 1):
            for keyword in error_keywords:
                if keyword in line.upper():
                    errors.append({
                        'type': keyword,
                        'line_number': i,
                        'message': line.strip()[:200],
                        'severity': 'HIGH' if keyword in ['CRITICAL', 'FATAL'] else 'MEDIUM',
                        'category': 'Unknown',
                        'recommendation': 'Review and investigate this error'
                    })
                    break
        
        return {
            'errors': errors,
            'total_errors': len(errors),
            'summary': f"Found {len(errors)} potential issues using pattern matching. Configure OpenAI API key for detailed analysis."
        }
    
    def save_results(self, results: Dict[str, Any], output_path: str):
        """Save results to JSON file"""
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2)
        print(f"💾 Results saved to: {output_path}")
    
    def generate_report(self, results: Dict[str, Any], report_path: str):
        """Generate human-readable text report"""
        with open(report_path, 'w', encoding='utf-8') as f:
            f.write("="*80 + "\n")
            f.write("LOG ERROR ANALYSIS REPORT\n")
            f.write("="*80 + "\n\n")
            
            f.write(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"Total Errors: {results.get('total_errors', 0)}\n\n")
            
            f.write("SUMMARY\n")
            f.write("-"*80 + "\n")
            f.write(f"{results.get('summary', 'No summary available')}\n\n")
            
            f.write("="*80 + "\n\n")
            
            # Error details
            f.write("DETAILED ERRORS\n")
            f.write("="*80 + "\n\n")
            
            for i, error in enumerate(results.get('errors', []), 1):
                f.write(f"ERROR #{i}\n")
                f.write("-"*80 + "\n")
                f.write(f"Type: {error.get('type', 'N/A')}\n")
                f.write(f"Severity: {error.get('severity', 'N/A')}\n")
                f.write(f"Category: {error.get('category', 'N/A')}\n")
                f.write(f"Line: {error.get('line_number', 'N/A')}\n")
                f.write(f"Message: {error.get('message', 'N/A')}\n")
                f.write(f"Recommendation: {error.get('recommendation', 'N/A')}\n\n")
            
            f.write("="*80 + "\n")
        
        print(f"📄 Report saved to: {report_path}")
    
    def analyze_file(self, file_path: str, output_json: str = "results.json", 
                     output_report: str = "report.txt") -> Dict[str, Any]:
        """
        Complete analysis workflow
        
        Args:
            file_path: Path to log file
            output_json: Output JSON file path
            output_report: Output report file path
            
        Returns:
            Analysis results dictionary
        """
        print("\n" + "="*80)
        print("🚀 SIMPLE LOG ANALYZER - LANGCHAIN")
        print("="*80 + "\n")
        
        # Read file
        log_content = self.read_log_file(file_path)
        if not log_content:
            return {}
        
        # Analyze
        results = self.analyze_log(log_content)
        
        # Save results
        self.save_results(results, output_json)
        self.generate_report(results, output_report)
        
        # Display summary
        print("\n" + "="*80)
        print("📊 ANALYSIS COMPLETE")
        print("="*80)
        print(f"Errors Found: {results.get('total_errors', 0)}")
        print(f"JSON Output: {output_json}")
        print(f"Text Report: {output_report}")
        print("="*80 + "\n")
        
        return results


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description='Simple Log Error Analyzer using LangChain',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python log_analyzer_simple.py app.log
  python log_analyzer_simple.py app.log -o results.json -r report.txt
  python log_analyzer_simple.py app.log --model gpt-3.5-turbo
        """
    )
    
    parser.add_argument('log_file', help='Path to log file to analyze')
    parser.add_argument('-o', '--output', default='results.json', 
                       help='Output JSON file (default: results.json)')
    parser.add_argument('-r', '--report', default='report.txt',
                       help='Output text report (default: report.txt)')
    parser.add_argument('--model', default='gpt-4',
                       choices=['gpt-4', 'gpt-3.5-turbo', 'gpt-4-turbo'],
                       help='OpenAI model (default: gpt-4)')
    
    args = parser.parse_args()
    
    # Check file exists
    if not os.path.exists(args.log_file):
        print(f"❌ Error: File not found: {args.log_file}")
        sys.exit(1)
    
    # Check API key
    if not os.getenv("OPENAI_API_KEY"):
        print("⚠️  Warning: OPENAI_API_KEY not set")
        print("Will use pattern matching fallback")
        print()
    
    # Run analysis
    analyzer = SimpleLogAnalyzer(model_name=args.model)
    analyzer.analyze_file(args.log_file, args.output, args.report)


if __name__ == "__main__":
    main()

