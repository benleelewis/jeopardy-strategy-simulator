import React, { useState, useEffect } from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

const JeopardyAnalysis = () => {
  const [dataPoints, setDataPoints] = useState([]);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [highlightedType, setHighlightedType] = useState('all');

  // Generate comprehensive dataset
  useEffect(() => {
    const generateDataPoints = () => {
      const points = [];
      
      // Famous players with estimated stats
      const famousPlayers = [
        { name: 'Ken Jennings', accuracy: 89, buzzIn: 45, type: 'champion', avgCoryat: 18500 },
        { name: 'James Holzhauer', accuracy: 86, buzzIn: 50, type: 'champion', avgCoryat: 22400 },
        { name: 'Brad Rutter', accuracy: 87, buzzIn: 42, type: 'champion', avgCoryat: 19200 },
        { name: 'Amy Schneider', accuracy: 85, buzzIn: 43, type: 'champion', avgCoryat: 17800 },
        { name: 'Matt Amodio', accuracy: 82, buzzIn: 41, type: 'champion', avgCoryat: 16900 },
        { name: 'Watson (IBM)', accuracy: 85, buzzIn: 48, type: 'computer', avgCoryat: 20800 },
        { name: 'Austin Rogers', accuracy: 78, buzzIn: 38, type: 'strong', avgCoryat: 15200 },
        { name: 'Julia Collins', accuracy: 81, buzzIn: 39, type: 'strong', avgCoryat: 16100 },
        { name: 'Arthur Chu', accuracy: 76, buzzIn: 35, type: 'strong', avgCoryat: 14300 },
        { name: 'Average Contestant', accuracy: 68, buzzIn: 28, type: 'average', avgCoryat: 12400 },
      ];

      // Add famous players
      famousPlayers.forEach(player => {
        points.push({
          name: player.name,
          accuracy: player.accuracy,
          buzzIn: player.buzzIn,
          coryat: calculateCoryat(player.accuracy, player.buzzIn),
          type: player.type,
          isNamed: true
        });
      });

      // Generate synthetic data points for comprehensive coverage
      const accuracyRanges = [
        { min: 50, max: 65, type: 'weak' },
        { min: 65, max: 75, type: 'average' },
        { min: 75, max: 85, type: 'strong' },
        { min: 85, max: 95, type: 'elite' }
      ];

      let pointId = 0;
      accuracyRanges.forEach(range => {
        for (let accuracy = range.min; accuracy <= range.max; accuracy += 2) {
          for (let buzzIn = 15; buzzIn <= 55; buzzIn += 3) {
            // Add some realistic constraints
            if (accuracy < 60 && buzzIn > 35) continue; // Weak players don't buzz in aggressively
            if (accuracy > 85 && buzzIn < 25) continue; // Strong players are more aggressive
            
            // Add jitter to prevent vertical lines
            const jitteredAccuracy = accuracy + (Math.random() - 0.5) * 3; // ±1.5% jitter
            const jitteredBuzzIn = buzzIn + (Math.random() - 0.5) * 4; // ±2% jitter
            
            const coryat = calculateCoryat(jitteredAccuracy, jitteredBuzzIn);
            points.push({
              name: `Player ${pointId++}`,
              accuracy: Math.round(jitteredAccuracy * 10) / 10, // Round to 1 decimal
              buzzIn: Math.round(jitteredBuzzIn * 10) / 10,
              coryat: coryat,
              type: range.type,
              isNamed: false
            });
          }
        }
      });

      return points;
    };

    setDataPoints(generateDataPoints());
  }, []);

  // Calculate Coryat based on accuracy and buzz-in percentage
  const calculateCoryat = (accuracy, buzzInPercentage) => {
    // Question values for each round
    const jeopardyValues = [200, 400, 600, 800, 1000];
    const doubleJeopardyValues = [400, 800, 1200, 1600, 2000];
    
    let estimatedCoryat = 0;
    
    // Calculate for Jeopardy round
    jeopardyValues.forEach(value => {
      const questionsAtThisValue = 6;
      const difficultyMultiplier = Math.max(0.3, 1 - (value / 1000 * 0.3));
      const adjustedAccuracy = (accuracy / 100) * difficultyMultiplier;
      const buzzInChance = buzzInPercentage / 100;
      const questionsWon = questionsAtThisValue * buzzInChance * adjustedAccuracy;
      estimatedCoryat += value * questionsWon;
    });
    
    // Calculate for Double Jeopardy round
    doubleJeopardyValues.forEach(value => {
      const questionsAtThisValue = 6;
      const difficultyMultiplier = Math.max(0.25, 1 - (value / 2000 * 0.4));
      const adjustedAccuracy = (accuracy / 100) * difficultyMultiplier;
      const buzzInChance = buzzInPercentage / 100;
      const questionsWon = questionsAtThisValue * buzzInChance * adjustedAccuracy;
      estimatedCoryat += value * questionsWon;
    });

    return Math.round(estimatedCoryat);
  };

  const getTypeColor = (type, isHighlighted) => {
    if (highlightedType !== 'all' && highlightedType !== type && !isHighlighted) {
      return '#E5E7EB'; // Gray for non-highlighted
    }
    
    switch (type) {
      case 'champion': return '#FFD700';
      case 'computer': return '#FF6B6B';
      case 'strong': return '#4ECDC4';
      case 'elite': return '#9B59B6';
      case 'average': return '#45B7D1';
      case 'weak': return '#96CEB4';
      default: return '#BDC3C7';
    }
  };

  const getPointSize = (point) => {
    if (point.isNamed) return 8;
    if (selectedPoint && selectedPoint.name === point.name) return 6;
    return 4;
  };

  const handlePointClick = (data) => {
    if (data && data.activePayload && data.activePayload[0]) {
      setSelectedPoint(data.activePayload[0].payload);
    }
  };

  const filteredData = dataPoints.filter(point => {
    if (highlightedType === 'all') return true;
    return point.type === highlightedType;
  });

  const CustomTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white p-3 border border-gray-300 rounded shadow-lg">
          <p className="font-semibold">{data.name}</p>
          <p>Accuracy: {data.accuracy}%</p>
          <p>Buzz-in: {data.buzzIn}%</p>
          <p>Estimated Coryat: ${data.coryat.toLocaleString()}</p>
          <p className="text-sm text-gray-600 capitalize">{data.type}</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="max-w-7xl mx-auto p-6 bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen">
      <div className="bg-white rounded-lg shadow-xl p-8">
        <h1 className="text-4xl font-bold text-center mb-2 text-blue-900">
          Jeopardy! Buzz-in Rate vs Coryat Analysis
        </h1>
        <p className="text-center text-gray-600 mb-8">
          Relationship between buzz-in percentage and estimated Coryat score ({dataPoints.length} data points)
        </p>

        {/* Filter Controls */}
        <div className="mb-6 flex flex-wrap gap-2 justify-center">
          <button
            onClick={() => setHighlightedType('all')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              highlightedType === 'all' 
                ? 'bg-blue-600 text-white' 
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            All Players ({dataPoints.length})
          </button>
          <button
            onClick={() => setHighlightedType('champion')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              highlightedType === 'champion' 
                ? 'bg-yellow-500 text-white' 
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Champions ({dataPoints.filter(p => p.type === 'champion').length})
          </button>
          <button
            onClick={() => setHighlightedType('elite')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              highlightedType === 'elite' 
                ? 'bg-purple-600 text-white' 
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Elite ({dataPoints.filter(p => p.type === 'elite').length})
          </button>
          <button
            onClick={() => setHighlightedType('strong')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              highlightedType === 'strong' 
                ? 'bg-teal-500 text-white' 
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Strong ({dataPoints.filter(p => p.type === 'strong').length})
          </button>
          <button
            onClick={() => setHighlightedType('average')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              highlightedType === 'average' 
                ? 'bg-blue-500 text-white' 
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Average ({dataPoints.filter(p => p.type === 'average').length})
          </button>
          <button
            onClick={() => setHighlightedType('weak')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              highlightedType === 'weak' 
                ? 'bg-green-400 text-white' 
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Weak ({dataPoints.filter(p => p.type === 'weak').length})
          </button>
        </div>

        {/* Main Scatter Plot */}
        <div className="bg-gray-50 rounded-lg p-6 mb-6">
          <ResponsiveContainer width="100%" height={600}>
            <ScatterChart
              margin={{ top: 20, right: 20, bottom: 60, left: 60 }}
              onClick={handlePointClick}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis 
                type="number" 
                dataKey="buzzIn" 
                domain={[10, 60]}
                label={{ value: 'Buzz-in Percentage (%)', position: 'insideBottom', offset: -10 }}
              />
              <YAxis 
                type="number" 
                dataKey="coryat" 
                domain={[5000, 25000]}
                label={{ value: 'Estimated Coryat ($)', angle: -90, position: 'insideLeft' }}
                tickFormatter={(value) => `$${(value/1000).toFixed(0)}k`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Scatter data={filteredData}>
                {filteredData.map((entry, index) => (
                  <Cell 
                    key={`cell-${index}`} 
                    fill={getTypeColor(entry.type, selectedPoint && selectedPoint.name === entry.name)}
                    r={getPointSize(entry)}
                    stroke={selectedPoint && selectedPoint.name === entry.name ? '#000' : 'none'}
                    strokeWidth={selectedPoint && selectedPoint.name === entry.name ? 2 : 0}
                  />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        {/* Selected Point Details */}
        {selectedPoint && (
          <div className="bg-blue-50 rounded-lg p-6 mb-6">
            <h3 className="text-xl font-semibold mb-3">Selected Player Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-gray-600">Name</p>
                <p className="text-lg font-semibold">{selectedPoint.name}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Accuracy</p>
                <p className="text-lg font-semibold">{selectedPoint.accuracy}%</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Buzz-in Rate</p>
                <p className="text-lg font-semibold">{selectedPoint.buzzIn}%</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Estimated Coryat</p>
                <p className="text-lg font-semibold">${selectedPoint.coryat.toLocaleString()}</p>
              </div>
            </div>
          </div>
        )}

        {/* Analysis Summary */}
        <div className="bg-gray-50 rounded-lg p-6">
          <h3 className="text-xl font-semibold mb-4">Key Insights</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="font-semibold mb-2">Optimal Strategy Zone</h4>
              <p className="text-sm text-gray-700">
                The highest Coryat scores typically come from players with 40-50% buzz-in rates 
                and 85%+ accuracy. This represents the sweet spot of aggressive play with high success rates.
              </p>
            </div>
            <div>
              <h4 className="font-semibold mb-2">Risk vs Reward</h4>
              <p className="text-sm text-gray-700">
                Players with lower accuracy (60-70%) should be more conservative with buzz-ins (20-30%), 
                while elite players (85%+) can afford to be more aggressive (40-50%).
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default JeopardyAnalysis;